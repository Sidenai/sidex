package memory

import (
	"encoding/json"
	"fmt"
	"strings"
	"time"

	bolt "go.etcd.io/bbolt"
)

var (
	bucketSessions    = []byte("sessions")
	bucketMemory      = []byte("memory")
	bucketFacts       = []byte("facts")
	bucketTranscripts = []byte("transcripts")
)

type Store struct {
	db *bolt.DB
}

type MemoryEntry struct {
	ID        string    `json:"id"`
	UserID    string    `json:"user_id,omitempty"`
	Key       string    `json:"key"`
	Value     string    `json:"value"`
	Tags      []string  `json:"tags"`
	CreatedAt time.Time `json:"created_at"`
	AccessCnt int       `json:"access_count"`
}

type SessionRecord struct {
	ID        string    `json:"id"`
	UserID    string    `json:"user_id,omitempty"`
	Title     string    `json:"title"`
	Messages  int       `json:"messages"`
	Tokens    int       `json:"tokens_used"`
	CreatedAt time.Time `json:"created_at"`
	UpdatedAt time.Time `json:"updated_at"`
	CWD       string    `json:"cwd"`
}

func NewBoltStore(path string) (*Store, error) {
	db, err := bolt.Open(path, 0600, &bolt.Options{Timeout: 2 * time.Second})
	if err != nil {
		return nil, err
	}

	err = db.Update(func(tx *bolt.Tx) error {
		for _, b := range [][]byte{bucketSessions, bucketMemory, bucketFacts, bucketTranscripts} {
			if _, err := tx.CreateBucketIfNotExists(b); err != nil {
				return err
			}
		}
		return nil
	})
	if err != nil {
		db.Close()
		return nil, err
	}

	return &Store{db: db}, nil
}

func (s *Store) Close() error {
	return s.db.Close()
}

func (s *Store) SaveMemory(entry MemoryEntry) error {
	return s.db.Update(func(tx *bolt.Tx) error {
		b := tx.Bucket(bucketMemory)
		data, err := json.Marshal(entry)
		if err != nil {
			return err
		}
		return b.Put([]byte(entry.ID), data)
	})
}

func (s *Store) GetMemory(id string) (*MemoryEntry, error) {
	var entry MemoryEntry
	err := s.db.View(func(tx *bolt.Tx) error {
		b := tx.Bucket(bucketMemory)
		data := b.Get([]byte(id))
		if data == nil {
			return fmt.Errorf("not found")
		}
		return json.Unmarshal(data, &entry)
	})
	if err != nil {
		return nil, err
	}

	s.db.Update(func(tx *bolt.Tx) error {
		entry.AccessCnt++
		b := tx.Bucket(bucketMemory)
		data, _ := json.Marshal(entry)
		return b.Put([]byte(entry.ID), data)
	})

	return &entry, nil
}

func (s *Store) SearchMemory(query string) ([]MemoryEntry, error) {
	var results []MemoryEntry
	q := strings.ToLower(query)

	err := s.db.View(func(tx *bolt.Tx) error {
		b := tx.Bucket(bucketMemory)
		return b.ForEach(func(k, v []byte) error {
			var entry MemoryEntry
			if err := json.Unmarshal(v, &entry); err != nil {
				return nil
			}
			if strings.Contains(strings.ToLower(entry.Key), q) ||
				strings.Contains(strings.ToLower(entry.Value), q) ||
				matchTags(entry.Tags, q) {
				results = append(results, entry)
			}
			return nil
		})
	})
	return results, err
}

func (s *Store) SearchMemoryForUser(query, userID string) ([]MemoryEntry, error) {
	all, err := s.SearchMemory(query)
	if err != nil {
		return nil, err
	}
	return filterMemoryByUser(all, userID), nil
}

func (s *Store) AllMemory() ([]MemoryEntry, error) {
	var results []MemoryEntry
	err := s.db.View(func(tx *bolt.Tx) error {
		b := tx.Bucket(bucketMemory)
		return b.ForEach(func(k, v []byte) error {
			var entry MemoryEntry
			if err := json.Unmarshal(v, &entry); err != nil {
				return nil
			}
			results = append(results, entry)
			return nil
		})
	})
	return results, err
}

func (s *Store) AllMemoryForUser(userID string) ([]MemoryEntry, error) {
	all, err := s.AllMemory()
	if err != nil {
		return nil, err
	}
	return filterMemoryByUser(all, userID), nil
}

func filterMemoryByUser(entries []MemoryEntry, userID string) []MemoryEntry {
	filtered := make([]MemoryEntry, 0, len(entries))
	for _, entry := range entries {
		if entry.UserID == userID {
			filtered = append(filtered, entry)
		}
	}
	return filtered
}

func (s *Store) DeleteMemory(id string) error {
	return s.db.Update(func(tx *bolt.Tx) error {
		return tx.Bucket(bucketMemory).Delete([]byte(id))
	})
}

func (s *Store) SaveSession(rec SessionRecord) error {
	return s.db.Update(func(tx *bolt.Tx) error {
		b := tx.Bucket(bucketSessions)
		data, err := json.Marshal(rec)
		if err != nil {
			return err
		}
		return b.Put([]byte(rec.ID), data)
	})
}

func (s *Store) GetSession(id string) (*SessionRecord, error) {
	var rec SessionRecord
	err := s.db.View(func(tx *bolt.Tx) error {
		b := tx.Bucket(bucketSessions)
		data := b.Get([]byte(id))
		if data == nil {
			return fmt.Errorf("not found")
		}
		return json.Unmarshal(data, &rec)
	})
	return &rec, err
}

func (s *Store) ListSessions() ([]SessionRecord, error) {
	var results []SessionRecord
	err := s.db.View(func(tx *bolt.Tx) error {
		b := tx.Bucket(bucketSessions)
		return b.ForEach(func(k, v []byte) error {
			var rec SessionRecord
			if err := json.Unmarshal(v, &rec); err != nil {
				return nil
			}
			results = append(results, rec)
			return nil
		})
	})
	return results, err
}

func (s *Store) DeleteSession(id string) error {
	return s.db.Update(func(tx *bolt.Tx) error {
		return tx.Bucket(bucketSessions).Delete([]byte(id))
	})
}

func (s *Store) SaveFact(key, value string) error {
	return s.db.Update(func(tx *bolt.Tx) error {
		return tx.Bucket(bucketFacts).Put([]byte(key), []byte(value))
	})
}

func (s *Store) GetFact(key string) (string, error) {
	var val string
	err := s.db.View(func(tx *bolt.Tx) error {
		data := tx.Bucket(bucketFacts).Get([]byte(key))
		if data == nil {
			return fmt.Errorf("not found")
		}
		val = string(data)
		return nil
	})
	return val, err
}

func matchTags(tags []string, query string) bool {
	for _, t := range tags {
		if strings.Contains(strings.ToLower(t), query) {
			return true
		}
	}
	return false
}

func (s *Store) SaveTranscript(id string, data []byte) error {
	return s.db.Update(func(tx *bolt.Tx) error {
		return tx.Bucket(bucketTranscripts).Put([]byte(id), data)
	})
}

func (s *Store) LoadTranscript(id string) ([]byte, error) {
	var data []byte
	err := s.db.View(func(tx *bolt.Tx) error {
		v := tx.Bucket(bucketTranscripts).Get([]byte(id))
		if v == nil {
			return fmt.Errorf("transcript not found")
		}
		data = make([]byte, len(v))
		copy(data, v)
		return nil
	})
	return data, err
}

func (s *Store) ListTranscriptIDs() ([]string, error) {
	var ids []string
	err := s.db.View(func(tx *bolt.Tx) error {
		return tx.Bucket(bucketTranscripts).ForEach(func(k, _ []byte) error {
			ids = append(ids, string(k))
			return nil
		})
	})
	return ids, err
}

func (s *Store) DeleteTranscript(id string) error {
	return s.db.Update(func(tx *bolt.Tx) error {
		return tx.Bucket(bucketTranscripts).Delete([]byte(id))
	})
}
