package localexec

import (
	"sync"
	"testing"
	"time"
)

func TestBrokerResolvesPendingWait(t *testing.T) {
	b := NewBroker()
	ch := b.Register("t1")
	go func() {
		time.Sleep(10 * time.Millisecond)
		b.Resolve(Response{ToolCallID: "t1", Output: "ok"})
	}()
	resp, err := b.Wait("t1", ch, 500*time.Millisecond)
	if err != nil {
		t.Fatalf("unexpected err: %v", err)
	}
	if resp.Output != "ok" {
		t.Fatalf("bad output: %q", resp.Output)
	}
	if b.InFlight() != 0 {
		t.Fatalf("waiter not cleaned up")
	}
}

func TestBrokerTimesOutWhenClientNeverReplies(t *testing.T) {
	b := NewBroker()
	ch := b.Register("t2")
	start := time.Now()
	_, err := b.Wait("t2", ch, 30*time.Millisecond)
	if err != ErrTimeout {
		t.Fatalf("expected timeout, got %v", err)
	}
	if elapsed := time.Since(start); elapsed < 25*time.Millisecond {
		t.Fatalf("returned too quickly: %v", elapsed)
	}
	if b.InFlight() != 0 {
		t.Fatalf("timed out waiter not cleaned up")
	}
}

func TestBrokerLateResolveIsSafe(t *testing.T) {
	// Simulates a client that replies AFTER the timeout. Must not panic.
	b := NewBroker()
	ch := b.Register("t3")
	_, err := b.Wait("t3", ch, 10*time.Millisecond)
	if err != ErrTimeout {
		t.Fatalf("expected timeout")
	}
	// Late response should be a no-op.
	b.Resolve(Response{ToolCallID: "t3", Output: "late"})
}

func TestBrokerConcurrentCallsDontCross(t *testing.T) {
	b := NewBroker()
	n := 50
	var wg sync.WaitGroup
	for i := 0; i < n; i++ {
		wg.Add(1)
		go func(i int) {
			defer wg.Done()
			id := "c" + string(rune('a'+i%26)) + string(rune('0'+(i/26)%10))
			ch := b.Register(id)
			go func() {
				b.Resolve(Response{ToolCallID: id, Output: id})
			}()
			resp, err := b.Wait(id, ch, 500*time.Millisecond)
			if err != nil {
				t.Errorf("%s: %v", id, err)
				return
			}
			if resp.Output != id {
				t.Errorf("%s: got %q", id, resp.Output)
			}
		}(i)
	}
	wg.Wait()
	if b.InFlight() != 0 {
		t.Fatalf("leak: %d", b.InFlight())
	}
}

func TestBrokerCancelRemovesWaiter(t *testing.T) {
	b := NewBroker()
	_ = b.Register("x1")
	if b.InFlight() != 1 {
		t.Fatalf("expected 1 in-flight")
	}
	b.Cancel("x1")
	if b.InFlight() != 0 {
		t.Fatalf("cancel should remove waiter")
	}
}

func TestBrokerResolveWithNoWaiter(t *testing.T) {
	b := NewBroker()
	// No panic, no deadlock.
	b.Resolve(Response{ToolCallID: "nobody", Output: "meh"})
}
