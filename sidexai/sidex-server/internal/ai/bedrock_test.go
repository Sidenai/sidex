package ai

import (
	"bytes"
	"encoding/base64"
	"encoding/binary"
	"encoding/hex"
	"encoding/json"
	"fmt"
	"hash/crc32"
	"net/http"
	"sort"
	"strings"
	"testing"
	"time"
)

// No test in this file makes a network call: signing is tested against
// AWS's own published test vector, and event-stream framing is tested
// against a byte-for-byte fixture lifted from aws-sdk-go-v2's own test suite
// (both cited at point of use) plus frames this file constructs itself.

// ---------------------------------------------------------------------------
// Credentials and region
// ---------------------------------------------------------------------------

func TestParseBedrockCredentials(t *testing.T) {
	cases := []struct {
		name    string
		raw     string
		want    bedrockCredentials
		wantErr bool
	}{
		{"key and secret", "AKIAEXAMPLE:secretvalue", bedrockCredentials{"AKIAEXAMPLE", "secretvalue", ""}, false},
		{"with session token", "AKIAEXAMPLE:secretvalue:sessiontoken", bedrockCredentials{"AKIAEXAMPLE", "secretvalue", "sessiontoken"}, false},
		{"session token containing colons stays intact", "AKIAEXAMPLE:secret:a:b:c", bedrockCredentials{"AKIAEXAMPLE", "secret", "a:b:c"}, false},
		{"missing secret", "AKIAEXAMPLE", bedrockCredentials{}, true},
		{"empty", "", bedrockCredentials{}, true},
		{"empty secret", "AKIAEXAMPLE:", bedrockCredentials{}, true},
	}
	for _, c := range cases {
		t.Run(c.name, func(t *testing.T) {
			got, err := parseBedrockCredentials(c.raw)
			if c.wantErr {
				if err == nil {
					t.Fatalf("expected an error, got %+v", got)
				}
				return
			}
			if err != nil {
				t.Fatalf("unexpected error: %v", err)
			}
			if got != c.want {
				t.Fatalf("got %+v, want %+v", got, c.want)
			}
		})
	}
}

func TestBedrockRegionFromHost(t *testing.T) {
	cases := []struct {
		name    string
		baseURL string
		want    string
		wantErr bool
	}{
		{"standard", "https://bedrock-runtime.us-east-1.amazonaws.com", "us-east-1", false},
		{"china partition", "https://bedrock-runtime.cn-north-1.amazonaws.com.cn", "cn-north-1", false},
		{"wrong host", "https://bedrock.us-east-1.amazonaws.com", "", true},
		{"not a bedrock host", "https://openrouter.ai/api/v1", "", true},
		{"invalid url", "://not a url", "", true},
	}
	for _, c := range cases {
		t.Run(c.name, func(t *testing.T) {
			got, err := bedrockRegionFromHost(c.baseURL)
			if c.wantErr {
				if err == nil {
					t.Fatalf("expected an error, got %q", got)
				}
				return
			}
			if err != nil {
				t.Fatalf("unexpected error: %v", err)
			}
			if got != c.want {
				t.Fatalf("got %q, want %q", got, c.want)
			}
		})
	}
}

// ---------------------------------------------------------------------------
// Model ids
// ---------------------------------------------------------------------------

func TestBedrockModelID(t *testing.T) {
	cases := []struct{ in, want string }{
		// The three models actually in SideX's catalog (internal/cost/pricing.go),
		// checked against AWS's current Bedrock model id table.
		{"anthropic/claude-sonnet-4.6", "global.anthropic.claude-sonnet-4-6"},
		{"anthropic/claude-opus-4.6", "global.anthropic.claude-opus-4-6-v1"},
		{"anthropic/claude-haiku-4.5", "global.anthropic.claude-haiku-4-5-20251001-v1:0"},
		// A model missing from the table falls back to the best-effort guess.
		{"anthropic/claude-mythos-preview", "anthropic.claude-mythos-preview"},
		// A literal Bedrock id (cross-region prefixed, or handed through
		// directly) passes through untouched.
		{"us.anthropic.claude-opus-4-6-v1", "us.anthropic.claude-opus-4-6-v1"},
		{"global.anthropic.claude-sonnet-4-6", "global.anthropic.claude-sonnet-4-6"},
	}
	for _, c := range cases {
		if got := BedrockModelID(c.in); got != c.want {
			t.Errorf("BedrockModelID(%q) = %q, want %q", c.in, got, c.want)
		}
	}
}

// ---------------------------------------------------------------------------
// AWS URI encoding
// ---------------------------------------------------------------------------

func TestAwsURIEncode(t *testing.T) {
	cases := []struct {
		in          string
		encodeSlash bool
		want        string
	}{
		{"anthropic.claude-haiku-4-5-20251001-v1:0", true, "anthropic.claude-haiku-4-5-20251001-v1%3A0"},
		{"model/with/slash", true, "model%2Fwith%2Fslash"},
		{"model/with/slash", false, "model/with/slash"},
		{"unreserved-._~ABC123", true, "unreserved-._~ABC123"},
	}
	for _, c := range cases {
		if got := awsURIEncode(c.in, c.encodeSlash); got != c.want {
			t.Errorf("awsURIEncode(%q, %v) = %q, want %q", c.in, c.encodeSlash, got, c.want)
		}
	}
}

// ---------------------------------------------------------------------------
// SigV4 signing
// ---------------------------------------------------------------------------

// TestDeriveAWSSigningKey_KnownVector checks the signing-key derivation and
// final HMAC against AWS's own published SigV4 test suite ("post-vanilla"
// case), fetched from
// https://raw.githubusercontent.com/saibotsivad/aws-sig-v4-test-suite/master/raw/aws-sig-v4-test-suite/post-vanilla/
// (a mirror of the fixtures at
// https://docs.aws.amazon.com/general/latest/gr/signature-v4-test-suite.html).
// This is the part of the algorithm least safe to eyeball -- a transposed
// step in the four-HMAC chain produces a signature that is wrong in every
// case but looks exactly as well-formed as a correct one.
func TestDeriveAWSSigningKey_KnownVector(t *testing.T) {
	const secretKey = "wJalrXUtnFEMI/K7MDENG+bPxRfiCYEXAMPLEKEY"
	const stringToSign = "AWS4-HMAC-SHA256\n" +
		"20150830T123600Z\n" +
		"20150830/us-east-1/service/aws4_request\n" +
		"553f88c9e4d10fc9e109e2aeb65f030801b70c2f6468faca261d401ae622fc87"
	const wantSignature = "5da7c1a2acd57cee7505fc6676e4e544621c30862966e37dddb68e92efbe5d6b"

	key := deriveAWSSigningKey(secretKey, "20150830", "us-east-1", "service")
	got := hex.EncodeToString(hmacSHA256(key, stringToSign))
	if got != wantSignature {
		t.Fatalf("signature = %s, want %s", got, wantSignature)
	}
}

// TestSignAWSRequestV4_MatchesManualComputation checks signAWSRequestV4's
// header selection, ordering, and canonical-request assembly by
// reconstructing the expected Authorization header independently (using the
// signing-key derivation already proven correct above) and comparing.
func TestSignAWSRequestV4_MatchesManualComputation(t *testing.T) {
	body := []byte(`{"anthropic_version":"bedrock-2023-05-31"}`)
	req, err := http.NewRequest("POST",
		"https://bedrock-runtime.us-east-1.amazonaws.com/model/anthropic.claude-sonnet-4-6/invoke-with-response-stream",
		bytes.NewReader(body))
	if err != nil {
		t.Fatalf("NewRequest: %v", err)
	}
	req.Header.Set("Content-Type", "application/json")
	req.Header.Set("Accept", "application/vnd.amazon.eventstream") // unsigned; must not appear in SignedHeaders

	creds := bedrockCredentials{
		accessKeyID:     "AKIDEXAMPLE",
		secretAccessKey: "wJalrXUtnFEMI/K7MDENG+bPxRfiCYEXAMPLEKEY",
		sessionToken:    "TOKEN123",
	}
	now := time.Date(2015, 8, 30, 12, 36, 0, 0, time.UTC)

	signAWSRequestV4(req, body, creds, "us-east-1", "bedrock", now)

	if got := req.Header.Get("X-Amz-Security-Token"); got != "TOKEN123" {
		t.Fatalf("X-Amz-Security-Token = %q, want TOKEN123", got)
	}
	if got := req.Header.Get("X-Amz-Date"); got != "20150830T123600Z" {
		t.Fatalf("X-Amz-Date = %q, want 20150830T123600Z", got)
	}

	payloadHash := hex.EncodeToString(sha256Sum(body))
	signedHeaders := "content-type;host;x-amz-content-sha256;x-amz-date;x-amz-security-token"
	canonicalHeaders := "content-type:application/json\n" +
		"host:bedrock-runtime.us-east-1.amazonaws.com\n" +
		"x-amz-content-sha256:" + payloadHash + "\n" +
		"x-amz-date:20150830T123600Z\n" +
		"x-amz-security-token:TOKEN123\n"
	canonicalRequest := strings.Join([]string{
		"POST",
		"/model/anthropic.claude-sonnet-4-6/invoke-with-response-stream",
		"",
		canonicalHeaders,
		signedHeaders,
		payloadHash,
	}, "\n")
	credScope := "20150830/us-east-1/bedrock/aws4_request"
	stringToSign := strings.Join([]string{
		"AWS4-HMAC-SHA256",
		"20150830T123600Z",
		credScope,
		hex.EncodeToString(sha256Sum([]byte(canonicalRequest))),
	}, "\n")
	key := deriveAWSSigningKey(creds.secretAccessKey, "20150830", "us-east-1", "bedrock")
	wantSig := hex.EncodeToString(hmacSHA256(key, stringToSign))
	wantAuth := fmt.Sprintf("AWS4-HMAC-SHA256 Credential=%s/%s, SignedHeaders=%s, Signature=%s",
		creds.accessKeyID, credScope, signedHeaders, wantSig)

	if got := req.Header.Get("Authorization"); got != wantAuth {
		t.Fatalf("Authorization mismatch:\n got:  %s\n want: %s", got, wantAuth)
	}
}

// TestSignAWSRequestV4_NoSessionToken checks that SignedHeaders omits
// x-amz-security-token (and no such header is sent) when there is no
// session token to carry -- the common case for a long-term IAM user key.
func TestSignAWSRequestV4_NoSessionToken(t *testing.T) {
	body := []byte(`{}`)
	req, _ := http.NewRequest("POST", "https://bedrock-runtime.us-west-2.amazonaws.com/model/x/invoke-with-response-stream", bytes.NewReader(body))
	req.Header.Set("Content-Type", "application/json")

	creds := bedrockCredentials{accessKeyID: "AKID", secretAccessKey: "secret"}
	signAWSRequestV4(req, body, creds, "us-west-2", "bedrock", time.Now().UTC())

	if req.Header.Get("X-Amz-Security-Token") != "" {
		t.Fatalf("X-Amz-Security-Token should be absent without a session token")
	}
	auth := req.Header.Get("Authorization")
	if !strings.Contains(auth, "SignedHeaders=content-type;host;x-amz-content-sha256;x-amz-date,") {
		t.Fatalf("unexpected SignedHeaders in %q", auth)
	}
}

// ---------------------------------------------------------------------------
// AWS event-stream framing
// ---------------------------------------------------------------------------

// testEncodedMsg is byte-for-byte the fixture used by aws-sdk-go-v2's own
// TestDecoder_DecodeMultipleMessages
// (aws/protocol/eventstream/decode_test.go), an event with a single
// "content-type: application/json" header and payload `{'foo':'bar'}`.
// Decoding this against readEventStreamMessage checks this file's framing
// logic against a fixture this file did not construct.
var testEncodedMsg = []byte{
	0, 0, 0, 61, 0, 0, 0, 32, 7, 253, 131, 150, 12, 99, 111, 110, 116, 101,
	110, 116, 45, 116, 121, 112, 101, 7, 0, 16, 97, 112, 112, 108, 105, 99,
	97, 116, 105, 111, 110, 47, 106, 115, 111, 110, 123, 39, 102, 111, 111,
	39, 58, 39, 98, 97, 114, 39, 125, 141, 156, 8, 177,
}

func TestReadEventStreamMessage_KnownVector(t *testing.T) {
	msg, err := readEventStreamMessage(bytes.NewReader(testEncodedMsg))
	if err != nil {
		t.Fatalf("unexpected error: %v", err)
	}
	if got := msg.headers["content-type"]; got != "application/json" {
		t.Errorf("content-type header = %q, want application/json", got)
	}
	if got := string(msg.payload); got != "{'foo':'bar'}" {
		t.Errorf("payload = %q, want {'foo':'bar'}", got)
	}
}

func TestReadEventStreamMessage_ChecksumMismatch(t *testing.T) {
	corrupt := append([]byte{}, testEncodedMsg...)
	corrupt[40] ^= 0xFF // flip a byte inside the header value
	if _, err := readEventStreamMessage(bytes.NewReader(corrupt)); err == nil {
		t.Fatal("expected a checksum error, got none")
	}
}

func TestReadEventStreamMessage_CleanEOF(t *testing.T) {
	if _, err := readEventStreamMessage(bytes.NewReader(nil)); err == nil {
		t.Fatal("expected io.EOF, got none")
	}
}

// encodeTestEventStreamMessage builds one valid event-stream frame the same
// way readEventStreamMessage/TestReadEventStreamMessage_KnownVector proves
// that function decodes -- used below to synthesize a small Bedrock
// response for parseBedrockEventStream, which nothing in this package can
// otherwise produce without a live account.
func encodeTestEventStreamMessage(t *testing.T, headers map[string]string, payload []byte) []byte {
	t.Helper()

	names := make([]string, 0, len(headers))
	for k := range headers {
		names = append(names, k)
	}
	sort.Strings(names) // order is irrelevant on the wire; sorted only for reproducible test output

	var headerBytes []byte
	for _, name := range names {
		value := headers[name]
		headerBytes = append(headerBytes, byte(len(name)))
		headerBytes = append(headerBytes, name...)
		headerBytes = append(headerBytes, 7) // string value type
		vLen := make([]byte, 2)
		binary.BigEndian.PutUint16(vLen, uint16(len(value)))
		headerBytes = append(headerBytes, vLen...)
		headerBytes = append(headerBytes, value...)
	}

	totalLen := 12 + len(headerBytes) + len(payload) + 4
	prelude := make([]byte, 12)
	binary.BigEndian.PutUint32(prelude[0:4], uint32(totalLen))
	binary.BigEndian.PutUint32(prelude[4:8], uint32(len(headerBytes)))
	binary.BigEndian.PutUint32(prelude[8:12], crc32.ChecksumIEEE(prelude[0:8]))

	body := append(append([]byte{}, headerBytes...), payload...)
	crc := crc32.NewIEEE()
	crc.Write(prelude)
	crc.Write(body)

	out := append(append([]byte{}, prelude...), body...)
	crcBytes := make([]byte, 4)
	binary.BigEndian.PutUint32(crcBytes, crc.Sum32())
	return append(out, crcBytes...)
}

// bedrockChunkFrame wraps one Anthropic event as Bedrock's real wire format
// does: the frame payload is JSON `{"bytes":"<base64>"}`, not the event JSON
// directly -- confirmed against aws-sdk-go-v2's generated deserializer, see
// the comment on bedrockPayloadPart in bedrock.go.
func bedrockChunkFrame(t *testing.T, eventJSON string) []byte {
	t.Helper()
	envelope, err := json.Marshal(bedrockPayloadPart{Bytes: base64.StdEncoding.EncodeToString([]byte(eventJSON))})
	if err != nil {
		t.Fatalf("marshal envelope: %v", err)
	}
	return encodeTestEventStreamMessage(t, map[string]string{
		":message-type": "event",
		":event-type":   "chunk",
		":content-type": "application/json",
	}, envelope)
}

func TestParseBedrockEventStream_TextAndUsage(t *testing.T) {
	var stream bytes.Buffer
	stream.Write(bedrockChunkFrame(t, `{"type":"message_start","message":{"usage":{"input_tokens":10}}}`))
	stream.Write(bedrockChunkFrame(t, `{"type":"content_block_start","index":0,"content_block":{"type":"text","text":""}}`))
	stream.Write(bedrockChunkFrame(t, `{"type":"content_block_delta","index":0,"delta":{"type":"text_delta","text":"Hello"}}`))
	stream.Write(bedrockChunkFrame(t, `{"type":"content_block_stop","index":0}`))
	stream.Write(bedrockChunkFrame(t, `{"type":"message_delta","delta":{"stop_reason":"end_turn"},"usage":{"output_tokens":5}}`))
	stream.Write(bedrockChunkFrame(t, `{"type":"message_stop"}`))

	var chunks []StreamChunk
	if err := parseBedrockEventStream(&stream, func(c StreamChunk) { chunks = append(chunks, c) }); err != nil {
		t.Fatalf("unexpected error: %v", err)
	}

	var text strings.Builder
	var sawUsage, sawDone bool
	var usage *Usage
	for _, c := range chunks {
		switch c.Type {
		case "text":
			text.WriteString(c.Content)
		case "usage":
			sawUsage = true
			usage = c.TokensUsed
		case "done":
			sawDone = true
		case "tool_calls_complete":
			t.Errorf("unexpected tool_calls_complete with no tool calls in the stream")
		}
	}
	if text.String() != "Hello" {
		t.Errorf("text = %q, want %q", text.String(), "Hello")
	}
	if !sawUsage || usage == nil {
		t.Fatalf("expected a usage chunk")
	}
	if usage.PromptTokens != 10 || usage.CompletionTokens != 5 || usage.TotalTokens != 15 {
		t.Errorf("usage = %+v, want {Prompt:10 Completion:5 Total:15}", usage)
	}
	if !sawDone {
		t.Errorf("expected a done chunk")
	}
}

func TestParseBedrockEventStream_ToolCall(t *testing.T) {
	var stream bytes.Buffer
	stream.Write(bedrockChunkFrame(t, `{"type":"content_block_start","index":0,"content_block":{"type":"tool_use","id":"toolu_1","name":"get_weather"}}`))
	stream.Write(bedrockChunkFrame(t, `{"type":"content_block_delta","index":0,"delta":{"type":"input_json_delta","partial_json":"{\"city\":\"SF\"}"}}`))
	stream.Write(bedrockChunkFrame(t, `{"type":"content_block_stop","index":0}`))
	stream.Write(bedrockChunkFrame(t, `{"type":"message_stop"}`))

	var chunks []StreamChunk
	if err := parseBedrockEventStream(&stream, func(c StreamChunk) { chunks = append(chunks, c) }); err != nil {
		t.Fatalf("unexpected error: %v", err)
	}

	var gotComplete bool
	for _, c := range chunks {
		if c.Type == "tool_calls_complete" {
			gotComplete = true
			if len(c.ToolCalls) != 1 {
				t.Fatalf("expected 1 completed tool call, got %d", len(c.ToolCalls))
			}
			tc := c.ToolCalls[0]
			if tc.ID != "toolu_1" || tc.Function.Name != "get_weather" || tc.Function.Arguments != `{"city":"SF"}` {
				t.Errorf("unexpected tool call: %+v", tc)
			}
		}
	}
	if !gotComplete {
		t.Fatal("expected a tool_calls_complete chunk")
	}
}

func TestParseBedrockEventStream_ExceptionFrame(t *testing.T) {
	// Exception frames are plain JSON, not base64-wrapped -- confirmed
	// against aws-sdk-go-v2's exception deserializers (see bedrock.go).
	payload := []byte(`{"message":"too many tokens"}`)
	frame := encodeTestEventStreamMessage(t, map[string]string{
		":message-type":   "exception",
		":exception-type": "validationException",
	}, payload)

	err := parseBedrockEventStream(bytes.NewReader(frame), func(StreamChunk) {})
	if err == nil {
		t.Fatal("expected an error")
	}
	if !strings.Contains(err.Error(), "validationException") || !strings.Contains(err.Error(), "too many tokens") {
		t.Errorf("error %q missing expected content", err.Error())
	}
}
