package ai

import (
	"bytes"
	"crypto/hmac"
	"crypto/sha256"
	"encoding/base64"
	"encoding/binary"
	"encoding/hex"
	"encoding/json"
	"errors"
	"fmt"
	"hash/crc32"
	"io"
	"net/http"
	"net/url"
	"sort"
	"strings"
	"time"
)

// AWS Bedrock support for the anthropic.claude-* model family.
//
// This talks to the legacy `InvokeModelWithResponseStream` operation on
// `bedrock-runtime` (ARN-versioned model ids, AWS event-stream framing),
// not the newer Bedrock "Messages API" endpoint (`bedrock-mantle`, plain
// SSE, bearer-token auth). The legacy path is what has to be signed by
// hand: it needs full SigV4 request signing and a binary event-stream
// parser, both implemented below rather than pulled in from an AWS SDK --
// see the note above signAWSRequestV4 for why, and REPORT for what was
// verified against AWS's docs and the aws-sdk-go-v2 source before writing
// this.
//
// Request/response shape is otherwise the same Messages API anthropic.go
// already speaks: this file reuses buildAnthropicMessages, buildAnthropicTools,
// anthropicEvent/anthropicUsage and defaultAnthropicMaxTokens from that file
// rather than redefining them. The one piece that isn't reused is the SSE
// event dispatch loop inside parseAnthropicSSE -- it isn't factored out as a
// callable unit there, and this file may not edit anthropic.go, so
// parseBedrockEventStream re-implements the same event-type switch against
// the same anthropicEvent shape, driven by AWS event-stream frames instead
// of SSE lines.

const (
	// bedrockAnthropicVersion is Bedrock's own value for the field Anthropic's
	// direct API calls anthropic-version; Bedrock takes it in the body instead
	// of a header, and it is a different value.
	bedrockAnthropicVersion = "bedrock-2023-05-31"
	// bedrockService is the SigV4 service name for both bedrock-runtime and
	// bedrock-control-plane hosts.
	bedrockService = "bedrock"

	// AuthModeAWSSigV4 documents Bedrock's credential scheme for operators and
	// the Rust side that assembles SIDEX_PROVIDER_BEDROCK_AUTH. It is
	// informational only: streamBedrock always signs with SigV4 regardless of
	// c.authMode, since Bedrock has exactly one auth scheme and there is
	// nothing to branch on.
	AuthModeAWSSigV4 = "aws_sigv4"
)

// IsBedrockAnthropic reports whether a provider must use Bedrock's signed
// InvokeModelWithResponseStream path for the Anthropic model family.
func IsBedrockAnthropic(provider string) bool {
	return provider == "bedrock"
}

// ---------------------------------------------------------------------------
// Credentials
// ---------------------------------------------------------------------------

// bedrockCredentials is the AWS access key pair -- and, for STS-issued
// temporary credentials, a session token -- carried in the single
// SIDEX_PROVIDER_BEDROCK_KEY slot.
//
// Encoding: "<AccessKeyID>:<SecretAccessKey>" or
// "<AccessKeyID>:<SecretAccessKey>:<SessionToken>". A colon delimiter is safe
// here because none of the three fields ever contain one: access key ids
// match `[A-Z0-9]+`, and secret keys and session tokens are drawn from the
// base64 alphabet (A-Z a-z 0-9 + / =), which has no colon. This is the
// encoding the Rust side must produce when it resolves Bedrock credentials
// and writes SIDEX_PROVIDER_BEDROCK_KEY -- see REPORT.
type bedrockCredentials struct {
	accessKeyID     string
	secretAccessKey string
	sessionToken    string
}

func parseBedrockCredentials(raw string) (bedrockCredentials, error) {
	parts := strings.SplitN(raw, ":", 3)
	if len(parts) < 2 || parts[0] == "" || parts[1] == "" {
		return bedrockCredentials{}, errors.New(
			`Bedrock credential must be "<access-key-id>:<secret-access-key>" ` +
				`or "<access-key-id>:<secret-access-key>:<session-token>"`)
	}
	creds := bedrockCredentials{accessKeyID: parts[0], secretAccessKey: parts[1]}
	if len(parts) == 3 {
		creds.sessionToken = parts[2]
	}
	return creds, nil
}

// bedrockRegionFromHost extracts the AWS region from a Bedrock runtime host,
// e.g. "bedrock-runtime.us-east-1.amazonaws.com" -> "us-east-1".
//
// SigV4's credential scope is bound to a region, and Bedrock (unlike
// OpenRouter or Anthropic direct) has no single global endpoint -- every
// request goes to a region-specific host. Rather than invent a second env
// var for it, the region is read out of SIDEX_PROVIDER_BEDROCK_BASE_URL,
// which the app must already set per-region for the endpoint to resolve at
// all (see REPORT: bedrock is deliberately absent from DirectProviders, so
// LocalProviderConfig has no fallback base URL to hide a missing region behind).
func bedrockRegionFromHost(baseURL string) (string, error) {
	u, err := url.Parse(baseURL)
	if err != nil {
		return "", fmt.Errorf("invalid Bedrock base URL %q: %w", baseURL, err)
	}
	labels := strings.Split(u.Hostname(), ".")
	if len(labels) < 3 || labels[0] != "bedrock-runtime" {
		return "", fmt.Errorf(
			"Bedrock base URL must be a bedrock-runtime endpoint (bedrock-runtime.<region>.amazonaws.com), got %q",
			u.Hostname())
	}
	return labels[1], nil
}

// ---------------------------------------------------------------------------
// Model ids
// ---------------------------------------------------------------------------

// bedrockModelIDs maps the SideX catalog's Anthropic model ids (the part
// after "anthropic/") to the exact Bedrock model id to invoke, using the
// no-pricing-premium global cross-region endpoint. Verified against AWS's
// current Bedrock model id table as of 2026-08.
//
// This is a lookup table rather than a derived transform because Bedrock
// does not derive ids from the model name by a fixed rule: compare
// "global.anthropic.claude-sonnet-4-6" (no suffix) against
// "global.anthropic.claude-opus-4-6-v1" ("-v1", no date) against
// "global.anthropic.claude-haiku-4-5-20251001-v1:0" (date and "-v1:0"). Any
// one heuristic gets at least one of these wrong.
var bedrockModelIDs = map[string]string{
	"claude-sonnet-4.6": "global.anthropic.claude-sonnet-4-6",
	"claude-opus-4.6":   "global.anthropic.claude-opus-4-6-v1",
	"claude-haiku-4.5":  "global.anthropic.claude-haiku-4-5-20251001-v1:0",
}

// BedrockModelID converts a catalog model id into the id Bedrock's
// InvokeModelWithResponseStream path expects.
//
// If the id already contains "anthropic." it is assumed to already be a
// literal Bedrock id (optionally region-prefixed, e.g. "us.anthropic....",
// or a full inference-profile ARN) and is passed through untouched. This is
// the escape hatch for every model missing from bedrockModelIDs: an
// operator, or a future catalog entry, can hand this function the exact
// Bedrock id and skip the lookup entirely.
//
// A catalog id with no table entry and no "anthropic." falls back to a
// dot-to-dash rewrite with no version suffix. That fallback is a guess, not
// a verified id -- see the comment on bedrockModelIDs -- so it exists only
// to fail loudly (a 404/ValidationException from Bedrock) rather than to be
// silently correct. Add a table entry for any model this guess gets wrong.
func BedrockModelID(modelID string) string {
	id := modelID
	if parts := strings.SplitN(id, "/", 2); len(parts) == 2 {
		id = parts[1]
	}
	if strings.Contains(id, "anthropic.") {
		return id
	}
	if mapped, ok := bedrockModelIDs[id]; ok {
		return mapped
	}
	return "anthropic." + strings.ReplaceAll(id, ".", "-")
}

// ---------------------------------------------------------------------------
// Request shape
// ---------------------------------------------------------------------------

// bedrockRequest is the Messages API body Bedrock expects: the same shape
// anthropicRequest uses, minus `model` (it's in the URL, not the body) and
// `stream` (InvokeModelWithResponseStream streams unconditionally -- there
// is no non-streaming/streaming switch inside the body).
type bedrockRequest struct {
	AnthropicVersion string                 `json:"anthropic_version"`
	MaxTokens        int                    `json:"max_tokens"`
	System           string                 `json:"system,omitempty"`
	Messages         []anthropicMessage     `json:"messages"`
	Tools            []anthropicTool        `json:"tools,omitempty"`
	Thinking         *anthropicThinking     `json:"thinking,omitempty"`
	OutputConfig     *anthropicOutputConfig `json:"output_config,omitempty"`
}

// ---------------------------------------------------------------------------
// Streaming
// ---------------------------------------------------------------------------

// streamBedrock runs one turn against Bedrock's InvokeModelWithResponseStream,
// emitting the same StreamChunk sequence every other path produces.
func (c *Client) streamBedrock(
	messages []Message,
	tools []ToolDef,
	systemPrompt string,
	opts *StreamOptions,
	onChunk func(StreamChunk),
) error {
	creds, err := parseBedrockCredentials(c.apiKey)
	if err != nil {
		return err
	}
	region, err := bedrockRegionFromHost(c.baseURL)
	if err != nil {
		return err
	}

	maxTokens := defaultAnthropicMaxTokens
	if opts != nil && opts.MaxTokensOverride > 0 {
		maxTokens = opts.MaxTokensOverride
	}

	msgs, system := buildAnthropicMessages(messages, systemPrompt)
	body := bedrockRequest{
		AnthropicVersion: bedrockAnthropicVersion,
		MaxTokens:        maxTokens,
		System:           system,
		Messages:         msgs,
		Tools:            buildAnthropicTools(tools),
	}
	if cfg := thinkingForAnthropic(c.model, opts); cfg.Thinking != nil || cfg.OutputConfig != nil {
		body.Thinking = cfg.Thinking
		body.OutputConfig = cfg.OutputConfig
		if cfg.MinMaxTokens > body.MaxTokens {
			body.MaxTokens = cfg.MinMaxTokens
		}
	}

	payload, err := json.Marshal(body)
	if err != nil {
		return fmt.Errorf("failed to encode request: %w", err)
	}

	// modelId is a single URI path segment (see BedrockModelID's doc for why
	// it can itself contain "/" for an inference-profile ARN), so every byte
	// of it -- including any internal "/" -- is escaped, not just the
	// version suffix's ":".
	modelPath := awsURIEncode(BedrockModelID(c.model), true)
	endpoint := "https://bedrock-runtime." + region + ".amazonaws.com" +
		"/model/" + modelPath + "/invoke-with-response-stream"

	req, err := http.NewRequest("POST", endpoint, bytes.NewReader(payload))
	if err != nil {
		return err
	}
	req.Header.Set("Content-Type", "application/json")
	req.Header.Set("Accept", "application/vnd.amazon.eventstream")
	signAWSRequestV4(req, payload, creds, region, bedrockService, time.Now().UTC())

	resp, err := c.httpClient.Do(req)
	if err != nil {
		return fmt.Errorf("request failed: %w", err)
	}
	defer resp.Body.Close()

	if resp.StatusCode != 200 {
		b, _ := io.ReadAll(resp.Body)
		return fmt.Errorf("Bedrock API error %d: %s", resp.StatusCode, sanitizeAPIErrorBody(resp.StatusCode, b))
	}

	return parseBedrockEventStream(resp.Body, onChunk)
}

// ---------------------------------------------------------------------------
// SigV4 signing
// ---------------------------------------------------------------------------

// signAWSRequestV4 signs req for AWS Signature Version 4 and attaches the
// resulting Authorization header (plus X-Amz-Date, X-Amz-Content-Sha256, and
// X-Amz-Security-Token when a session token is present).
//
// This is a from-scratch implementation of the algorithm documented at
// https://docs.aws.amazon.com/general/latest/gr/sigv4-create-canonical-request.html,
// not a dependency on an AWS SDK: go.mod carries no AWS module today (see
// REPORT), and pulling in aws-sdk-go-v2 for one signed endpoint would be a
// heavy new dependency for the rest of this binary. The algorithm itself is
// small and stable enough to own directly, scoped tightly to what a single
// POST-with-known-length-JSON-body request needs: no query-string signing,
// no chunked/streaming payload signing (Bedrock's request body is signed as
// an ordinary in-memory buffer; only the *response* is event-stream framed),
// one fixed set of headers.
//
// Whether X-Amz-Security-Token belongs in the signed header set (vs. added
// only after the signature, unsigned) differs by AWS service and isn't
// guessable; AWS's own SigV4 guide gives Bedrock's answer directly: "if you
// are using temporary security credentials, you need to include
// x-amz-security-token in your request. You must add this header in the
// list of CanonicalHeaders" -- so it is signed here whenever present.
func signAWSRequestV4(req *http.Request, payload []byte, creds bedrockCredentials, region, service string, now time.Time) {
	amzDate := now.Format("20060102T150405Z")
	dateStamp := now.Format("20060102")
	payloadHash := hex.EncodeToString(sha256Sum(payload))

	req.Header.Set("X-Amz-Date", amzDate)
	req.Header.Set("X-Amz-Content-Sha256", payloadHash)
	if creds.sessionToken != "" {
		req.Header.Set("X-Amz-Security-Token", creds.sessionToken)
	}

	type header struct{ name, value string }
	headers := []header{{"host", req.URL.Host}}
	if ct := req.Header.Get("Content-Type"); ct != "" {
		headers = append(headers, header{"content-type", ct})
	}
	for name := range req.Header {
		if lower := strings.ToLower(name); strings.HasPrefix(lower, "x-amz-") {
			headers = append(headers, header{lower, req.Header.Get(name)})
		}
	}
	sort.Slice(headers, func(i, j int) bool { return headers[i].name < headers[j].name })

	var canonicalHeaders strings.Builder
	names := make([]string, 0, len(headers))
	for _, h := range headers {
		canonicalHeaders.WriteString(h.name)
		canonicalHeaders.WriteByte(':')
		canonicalHeaders.WriteString(strings.TrimSpace(h.value))
		canonicalHeaders.WriteByte('\n')
		names = append(names, h.name)
	}
	signedHeaders := strings.Join(names, ";")

	canonicalRequest := strings.Join([]string{
		"POST",
		req.URL.EscapedPath(),
		"", // no query string on this request
		canonicalHeaders.String(),
		signedHeaders,
		payloadHash,
	}, "\n")

	credentialScope := dateStamp + "/" + region + "/" + service + "/aws4_request"
	stringToSign := strings.Join([]string{
		"AWS4-HMAC-SHA256",
		amzDate,
		credentialScope,
		hex.EncodeToString(sha256Sum([]byte(canonicalRequest))),
	}, "\n")

	signingKey := deriveAWSSigningKey(creds.secretAccessKey, dateStamp, region, service)
	signature := hex.EncodeToString(hmacSHA256(signingKey, stringToSign))

	req.Header.Set("Authorization", fmt.Sprintf(
		"AWS4-HMAC-SHA256 Credential=%s/%s, SignedHeaders=%s, Signature=%s",
		creds.accessKeyID, credentialScope, signedHeaders, signature,
	))
}

// deriveAWSSigningKey is the SigV4 key-derivation chain: four successive
// HMACs scope a signing key to a date, region and service so a leaked
// signature (unlike a leaked long-term secret) is worthless outside that
// narrow scope.
func deriveAWSSigningKey(secretKey, dateStamp, region, service string) []byte {
	kDate := hmacSHA256([]byte("AWS4"+secretKey), dateStamp)
	kRegion := hmacSHA256(kDate, region)
	kService := hmacSHA256(kRegion, service)
	return hmacSHA256(kService, "aws4_request")
}

func hmacSHA256(key []byte, data string) []byte {
	h := hmac.New(sha256.New, key)
	h.Write([]byte(data))
	return h.Sum(nil)
}

func sha256Sum(data []byte) []byte {
	sum := sha256.Sum256(data)
	return sum[:]
}

// awsURIEncode percent-encodes a string per SigV4's UriEncode() rules: every
// byte except the unreserved set (A-Z a-z 0-9 - . _ ~) becomes %XX with
// uppercase hex digits. This is stricter than net/url's escaping (which, for
// example, leaves ':' and '@' unescaped) and is used verbatim for both the
// literal request path and the canonical request, so the two can never
// disagree with each other.
func awsURIEncode(s string, encodeSlash bool) string {
	var b strings.Builder
	for i := 0; i < len(s); i++ {
		c := s[i]
		switch {
		case c >= 'A' && c <= 'Z', c >= 'a' && c <= 'z', c >= '0' && c <= '9', c == '-', c == '.', c == '_', c == '~':
			b.WriteByte(c)
		case c == '/' && !encodeSlash:
			b.WriteByte(c)
		default:
			fmt.Fprintf(&b, "%%%02X", c)
		}
	}
	return b.String()
}

// ---------------------------------------------------------------------------
// AWS event-stream framing
// ---------------------------------------------------------------------------

// eventStreamMessage is one decoded frame of the `application/vnd.amazon.
// eventstream` wire format Bedrock's streaming response uses in place of
// plain SSE.
type eventStreamMessage struct {
	headers map[string]string
	payload []byte
}

// maxEventStreamMessageBytes bounds a single frame's claimed length before
// it is allocated. Real Bedrock chunks are at most a few KB; this only
// exists so a corrupted length field (or a non-Bedrock server on the other
// end of a misconfigured base URL) can't trigger a multi-GB allocation.
const maxEventStreamMessageBytes = 16 * 1024 * 1024

// readEventStreamMessage reads one binary-framed message: a 12-byte prelude
// (total length, headers length, prelude CRC), then that many bytes of
// headers, then the payload, then a trailing 4-byte message CRC. Both CRCs
// are a plain CRC32 (the IEEE/802.3 polynomial -- the same one zlib and gzip
// use), computed over every preceding byte of the message including the
// prelude's own length fields, but excluding the CRC field being checked.
//
// Verified against the reference decoder in aws-sdk-go-v2
// (aws/protocol/eventstream/decode.go) rather than derived from the prose
// spec alone, specifically to confirm the prelude CRC's bytes are folded
// into the running hash used for the message CRC (they are: the SDK reads
// the prelude CRC field itself through the same io.TeeReader-wrapped hasher
// used for everything else in the message).
func readEventStreamMessage(r io.Reader) (*eventStreamMessage, error) {
	prelude := make([]byte, 12)
	if _, err := io.ReadFull(r, prelude); err != nil {
		return nil, err // a clean io.EOF here means the stream ended normally
	}
	totalLen := binary.BigEndian.Uint32(prelude[0:4])
	headersLen := binary.BigEndian.Uint32(prelude[4:8])
	wirePreludeCRC := binary.BigEndian.Uint32(prelude[8:12])

	if got := crc32.ChecksumIEEE(prelude[0:8]); got != wirePreludeCRC {
		return nil, errors.New("event stream prelude checksum mismatch")
	}
	if totalLen < 16 || totalLen > maxEventStreamMessageBytes || uint64(headersLen) > uint64(totalLen)-16 {
		return nil, fmt.Errorf("event stream message has an invalid length (total=%d headers=%d)", totalLen, headersLen)
	}

	rest := make([]byte, totalLen-12) // headers + payload + trailing message CRC
	if _, err := io.ReadFull(r, rest); err != nil {
		return nil, fmt.Errorf("truncated event stream message: %w", err)
	}

	wireMessageCRC := binary.BigEndian.Uint32(rest[len(rest)-4:])
	crc := crc32.NewIEEE()
	crc.Write(prelude)
	crc.Write(rest[:len(rest)-4])
	if got := crc.Sum32(); got != wireMessageCRC {
		return nil, errors.New("event stream message checksum mismatch")
	}

	headers, err := parseEventStreamHeaders(rest[:headersLen])
	if err != nil {
		return nil, err
	}
	return &eventStreamMessage{headers: headers, payload: rest[headersLen : len(rest)-4]}, nil
}

// parseEventStreamHeaders decodes one message's header block. Bedrock only
// ever sends string-valued control headers (:message-type, :event-type,
// :exception-type, :content-type), but every value type is decoded here --
// not just skipped -- because an unhandled type would misread its own
// length and desync every header that follows it in the same block.
func parseEventStreamHeaders(b []byte) (map[string]string, error) {
	headers := make(map[string]string)
	for len(b) > 0 {
		nameLen := int(b[0])
		b = b[1:]
		if len(b) < nameLen+1 {
			return nil, errors.New("truncated event stream header")
		}
		name := string(b[:nameLen])
		b = b[nameLen:]
		valType := b[0]
		b = b[1:]

		var n int
		switch valType {
		case 0, 1: // bool true/false: no value bytes
			headers[name] = fmt.Sprintf("%v", valType == 0)
			continue
		case 2:
			n = 1
		case 3:
			n = 2
		case 4:
			n = 4
		case 5:
			n = 8
		case 8:
			n = 8
		case 9:
			n = 16
		case 6, 7: // byte array, string: 2-byte length prefix then the value
			if len(b) < 2 {
				return nil, errors.New("truncated event stream header value")
			}
			n = int(binary.BigEndian.Uint16(b[:2]))
			b = b[2:]
		default:
			return nil, fmt.Errorf("unknown event stream header value type %d", valType)
		}
		if len(b) < n {
			return nil, errors.New("truncated event stream header value")
		}
		if valType == 7 {
			headers[name] = string(b[:n])
		}
		b = b[n:]
	}
	return headers, nil
}

// ---------------------------------------------------------------------------
// Event dispatch
// ---------------------------------------------------------------------------

// bedrockPayloadPart is the JSON envelope a "chunk" event's frame payload
// decodes to. This is NOT the Anthropic event itself -- it's Bedrock's own
// wrapper, with the real event JSON base64-encoded inside `bytes`.
//
// Confirmed against aws-sdk-go-v2's generated deserializer
// (service/bedrockruntime/deserializers.go,
// awsRestjson1_deserializeDocumentPayloadPart): it JSON-decodes the frame
// payload and base64-decodes a "bytes" field, rather than treating the frame
// payload as the raw event JSON directly. Exception frames are the opposite
// -- plain JSON, no base64 -- which is why they're decoded separately below.
type bedrockPayloadPart struct {
	Bytes string `json:"bytes"`
}

// parseBedrockEventStream translates Bedrock's event-stream response into
// the same StreamChunk sequence parseAnthropicSSE produces from native
// Anthropic's SSE stream. See the file-level comment for why this loop
// exists instead of calling into anthropic.go.
func parseBedrockEventStream(r io.Reader, onChunk func(StreamChunk)) error {
	type pendingTool struct {
		id   string
		name string
		args strings.Builder
	}
	pending := map[int]*pendingTool{}
	var completed []ToolCall
	usage := Usage{}

	for {
		msg, err := readEventStreamMessage(r)
		if err == io.EOF {
			break
		}
		if err != nil {
			return fmt.Errorf("Bedrock event stream read failed: %w", err)
		}

		switch msg.headers[":message-type"] {
		case "exception":
			var body struct {
				Message string `json:"message"`
			}
			_ = json.Unmarshal(msg.payload, &body)
			if body.Message == "" {
				body.Message = string(msg.payload)
			}
			return fmt.Errorf("Bedrock stream error (%s): %s", msg.headers[":exception-type"], body.Message)
		case "error":
			return fmt.Errorf("Bedrock stream error (%s): %s", msg.headers[":error-code"], msg.headers[":error-message"])
		}
		if msg.headers[":event-type"] != "chunk" {
			continue // ignore anything we don't recognize rather than fail the turn
		}

		var part bedrockPayloadPart
		if err := json.Unmarshal(msg.payload, &part); err != nil || part.Bytes == "" {
			continue // a malformed frame should not kill the turn
		}
		eventJSON, err := base64.StdEncoding.DecodeString(part.Bytes)
		if err != nil {
			continue
		}

		var ev anthropicEvent
		if err := json.Unmarshal(eventJSON, &ev); err != nil {
			continue
		}

		// Mirrors parseAnthropicSSE's switch in anthropic.go exactly -- same
		// event names, same StreamChunk emissions -- because it decodes to
		// the same anthropicEvent shape. See the file-level comment for why
		// this isn't a shared function instead.
		switch ev.Type {
		case "message_start":
			if ev.Message != nil && ev.Message.Usage != nil {
				usage.PromptTokens = ev.Message.Usage.InputTokens
				usage.CacheCreationInputTokens = ev.Message.Usage.CacheCreationInputTokens
				usage.CacheReadInputTokens = ev.Message.Usage.CacheReadInputTokens
			}

		case "content_block_start":
			if ev.ContentBlock == nil {
				continue
			}
			switch ev.ContentBlock.Type {
			case "tool_use":
				pending[ev.Index] = &pendingTool{id: ev.ContentBlock.ID, name: ev.ContentBlock.Name}
			case "text":
				if ev.ContentBlock.Text != "" {
					onChunk(StreamChunk{Type: "text", Content: ev.ContentBlock.Text})
				}
			}

		case "content_block_delta":
			if ev.Delta == nil {
				continue
			}
			switch ev.Delta.Type {
			case "text_delta":
				if ev.Delta.Text != "" {
					onChunk(StreamChunk{Type: "text", Content: ev.Delta.Text})
				}
			case "input_json_delta":
				if p := pending[ev.Index]; p != nil {
					p.args.WriteString(ev.Delta.PartialJSON)
				}
			}

		case "content_block_stop":
			p := pending[ev.Index]
			if p == nil {
				continue
			}
			delete(pending, ev.Index)
			args := p.args.String()
			if strings.TrimSpace(args) == "" {
				args = "{}"
			}
			tc := ToolCall{
				ID:       p.id,
				Type:     "function",
				Function: ToolCallFunc{Name: p.name, Arguments: args},
			}
			completed = append(completed, tc)
			onChunk(StreamChunk{Type: "tool_call", ToolCalls: []ToolCall{tc}})

		case "message_delta":
			if ev.Usage != nil {
				usage.CompletionTokens = ev.Usage.OutputTokens
			}

		case "error":
			if ev.Error != nil {
				return fmt.Errorf("Bedrock stream error: %s", ev.Error.Message)
			}
			return errors.New("Bedrock stream error")

		case "message_stop":
			// Terminal event; totals are emitted below.
		}
	}

	usage.TotalTokens = usage.PromptTokens + usage.CompletionTokens
	if usage.TotalTokens > 0 {
		u := usage
		onChunk(StreamChunk{Type: "usage", TokensUsed: &u})
	}
	if len(completed) > 0 {
		onChunk(StreamChunk{Type: "tool_calls_complete", ToolCalls: completed})
	}
	onChunk(StreamChunk{Type: "done", Done: true})
	return nil
}
