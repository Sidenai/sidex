package session

import (
	"encoding/json"
	"fmt"
	"strings"
	"sync"
	"time"
	"unicode/utf8"

	"github.com/google/uuid"
	"github.com/sidex-ai/sidex-server/internal/ai"
	"github.com/sidex-ai/sidex-server/internal/memory"
	"github.com/sidex-ai/sidex-server/internal/tools"
)

type Transcript struct {
	ID        string       `json:"id"`
	UserID    string       `json:"user_id,omitempty"`
	CWD       string       `json:"cwd"`
	Messages  []ai.Message `json:"messages"`
	CreatedAt time.Time    `json:"created_at"`
	UpdatedAt time.Time    `json:"updated_at"`
	Title     string       `json:"title,omitempty"`
	TokensIn  int          `json:"tokens_in"`
	TokensOut int          `json:"tokens_out"`
}

type Session struct {
	ID        string       `json:"id"`
	UserID    string       `json:"user_id,omitempty"`
	Messages  []ai.Message `json:"messages"`
	Tools     *tools.Registry
	CreatedAt time.Time `json:"created_at"`
	UpdatedAt time.Time `json:"updated_at"`
	CWD       string    `json:"cwd"`
	Title     string    `json:"title,omitempty"`
	TokensIn  int       `json:"tokens_in"`
	TokensOut int       `json:"tokens_out"`
	mu        sync.Mutex
}

type Manager struct {
	sessions sync.Map
	store    *memory.Store
}

func NewManager(store *memory.Store) *Manager {
	return &Manager{store: store}
}

func (m *Manager) Create(cwd string) *Session {
	return m.CreateForUser(cwd, "")
}

func (m *Manager) CreateForUser(cwd, userID string) *Session {
	s := &Session{
		ID:        uuid.New().String(),
		UserID:    userID,
		Messages:  []ai.Message{},
		Tools:     tools.NewRegistryForUser(cwd, userID, m.store),
		CreatedAt: time.Now(),
		UpdatedAt: time.Now(),
		CWD:       cwd,
	}
	m.sessions.Store(s.ID, s)

	m.store.SaveSession(memory.SessionRecord{
		ID:        s.ID,
		UserID:    s.UserID,
		Title:     "New Session",
		CreatedAt: s.CreatedAt,
		UpdatedAt: s.UpdatedAt,
		CWD:       cwd,
	})

	return s
}

func (m *Manager) Get(id string) *Session {
	v, ok := m.sessions.Load(id)
	if !ok {
		return nil
	}
	return v.(*Session)
}

func (m *Manager) Delete(id string) {
	m.sessions.Delete(id)
	m.store.DeleteSession(id)
	m.store.DeleteTranscript(id)
}

func (m *Manager) List() []*Session {
	var out []*Session
	m.sessions.Range(func(key, value interface{}) bool {
		out = append(out, value.(*Session))
		return true
	})
	return out
}

func (m *Manager) ListForUser(userID string) []*Session {
	var out []*Session
	m.sessions.Range(func(key, value interface{}) bool {
		sess := value.(*Session)
		if sess.UserID == userID {
			out = append(out, sess)
		}
		return true
	})
	return out
}

func (m *Manager) SaveTranscript(sess *Session) error {
	sess.mu.Lock()
	t := Transcript{
		ID:        sess.ID,
		UserID:    sess.UserID,
		CWD:       sess.CWD,
		Messages:  make([]ai.Message, len(sess.Messages)),
		CreatedAt: sess.CreatedAt,
		UpdatedAt: sess.UpdatedAt,
		Title:     sess.Title,
		TokensIn:  sess.TokensIn,
		TokensOut: sess.TokensOut,
	}
	copy(t.Messages, sess.Messages)
	sess.mu.Unlock()

	data, err := json.Marshal(t)
	if err != nil {
		return fmt.Errorf("marshal transcript: %w", err)
	}
	if err := m.store.SaveTranscript(t.ID, data); err != nil {
		return fmt.Errorf("persist transcript: %w", err)
	}

	m.store.SaveSession(memory.SessionRecord{
		ID:        t.ID,
		UserID:    t.UserID,
		Title:     t.Title,
		Messages:  len(t.Messages),
		Tokens:    t.TokensIn + t.TokensOut,
		CreatedAt: t.CreatedAt,
		UpdatedAt: t.UpdatedAt,
		CWD:       t.CWD,
	})
	return nil
}

func (m *Manager) LoadTranscript(id string) (*Session, error) {
	data, err := m.store.LoadTranscript(id)
	if err != nil {
		return nil, fmt.Errorf("load transcript: %w", err)
	}
	var t Transcript
	if err := json.Unmarshal(data, &t); err != nil {
		return nil, fmt.Errorf("unmarshal transcript: %w", err)
	}

	sess := &Session{
		ID:        t.ID,
		UserID:    t.UserID,
		Messages:  t.Messages,
		Tools:     tools.NewRegistryForUser(t.CWD, t.UserID, m.store),
		CreatedAt: t.CreatedAt,
		UpdatedAt: t.UpdatedAt,
		CWD:       t.CWD,
		Title:     t.Title,
		TokensIn:  t.TokensIn,
		TokensOut: t.TokensOut,
	}
	if sess.Messages == nil {
		sess.Messages = []ai.Message{}
	}

	m.sessions.Store(sess.ID, sess)
	return sess, nil
}

func (m *Manager) ListTranscripts() ([]Transcript, error) {
	ids, err := m.store.ListTranscriptIDs()
	if err != nil {
		return nil, err
	}

	transcripts := make([]Transcript, 0, len(ids))
	for _, id := range ids {
		data, err := m.store.LoadTranscript(id)
		if err != nil {
			continue
		}
		var t Transcript
		if err := json.Unmarshal(data, &t); err != nil {
			continue
		}
		// Return metadata only — omit heavy message payloads.
		t.Messages = nil
		transcripts = append(transcripts, t)
	}
	return transcripts, nil
}

func (m *Manager) ListTranscriptsForUser(userID string) ([]Transcript, error) {
	all, err := m.ListTranscripts()
	if err != nil {
		return nil, err
	}
	filtered := make([]Transcript, 0, len(all))
	for _, transcript := range all {
		if transcript.UserID == userID {
			filtered = append(filtered, transcript)
		}
	}
	return filtered, nil
}

func (m *Manager) SetTitle(id, title string) error {
	if s := m.Get(id); s != nil {
		s.mu.Lock()
		s.Title = title
		s.mu.Unlock()
		return m.SaveTranscript(s)
	}
	return fmt.Errorf("session %s not found", id)
}

// GenerateTitle creates a short title from the first user message if no title
// is set. It truncates to maxLen runes at a word boundary.
func GenerateTitle(firstUserMsg string, maxLen int) string {
	msg := strings.TrimSpace(firstUserMsg)
	if msg == "" {
		return "New Session"
	}
	if utf8.RuneCountInString(msg) <= maxLen {
		return msg
	}
	runes := []rune(msg)
	truncated := string(runes[:maxLen])
	if idx := strings.LastIndexAny(truncated, " \t\n"); idx > 0 {
		truncated = truncated[:idx]
	}
	return truncated + "…"
}

func (s *Session) AddMessage(msg ai.Message) {
	s.mu.Lock()
	defer s.mu.Unlock()
	s.Messages = append(s.Messages, msg)
	s.UpdatedAt = time.Now()
}

func (s *Session) GetMessages() []ai.Message {
	s.mu.Lock()
	defer s.mu.Unlock()
	cp := make([]ai.Message, len(s.Messages))
	copy(cp, s.Messages)
	return cp
}

func (s *Session) ReplaceMessages(msgs []ai.Message) {
	s.mu.Lock()
	defer s.mu.Unlock()
	s.Messages = msgs
	s.UpdatedAt = time.Now()
}
