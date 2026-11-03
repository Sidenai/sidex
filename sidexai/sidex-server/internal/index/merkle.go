package index

import (
	"crypto/sha256"
	"encoding/hex"
	"sort"
	"strings"
	"sync"
)

// MerkleNode represents a single node in the Merkle tree.
type MerkleNode struct {
	Hash   [sha256.Size]byte
	Path   string // non-empty for leaf nodes
	Left   *MerkleNode
	Right  *MerkleNode
	IsLeaf bool
}

// MerkleTree provides content-addressable workspace state for incremental sync.
// Client sends their root hash; if it matches the server's, no sync is needed.
// Otherwise, the tree is walked to identify exactly which files changed.
type MerkleTree struct {
	root   *MerkleNode
	leaves map[string]*MerkleNode // path → leaf for quick lookup
}

// NamespaceState stores persisted Merkle tree state per namespace.
type NamespaceState struct {
	mu          sync.RWMutex
	trees       map[string]*MerkleTree
	totalChunks map[string]int
	lastSynced  map[string]string // namespace → ISO timestamp
}

// NewNamespaceState creates a new in-memory namespace state store.
func NewNamespaceState() *NamespaceState {
	return &NamespaceState{
		trees:       make(map[string]*MerkleTree),
		totalChunks: make(map[string]int),
		lastSynced:  make(map[string]string),
	}
}

func (ns *NamespaceState) Get(namespace string) *MerkleTree {
	ns.mu.RLock()
	defer ns.mu.RUnlock()
	return ns.trees[namespace]
}

func (ns *NamespaceState) Set(namespace string, tree *MerkleTree) {
	ns.mu.Lock()
	defer ns.mu.Unlock()
	ns.trees[namespace] = tree
}

func (ns *NamespaceState) SetChunks(namespace string, count int) {
	ns.mu.Lock()
	defer ns.mu.Unlock()
	ns.totalChunks[namespace] = count
}

func (ns *NamespaceState) GetChunks(namespace string) int {
	ns.mu.RLock()
	defer ns.mu.RUnlock()
	return ns.totalChunks[namespace]
}

func (ns *NamespaceState) SetLastSynced(namespace, ts string) {
	ns.mu.Lock()
	defer ns.mu.Unlock()
	ns.lastSynced[namespace] = ts
}

func (ns *NamespaceState) GetLastSynced(namespace string) string {
	ns.mu.RLock()
	defer ns.mu.RUnlock()
	return ns.lastSynced[namespace]
}

func (ns *NamespaceState) Delete(namespace string) {
	ns.mu.Lock()
	defer ns.mu.Unlock()
	delete(ns.trees, namespace)
	delete(ns.totalChunks, namespace)
	delete(ns.lastSynced, namespace)
}

// BuildTree constructs a Merkle tree from file paths and their contents.
// Files are sorted by path to ensure deterministic tree structure.
func BuildTree(files map[string][]byte) *MerkleTree {
	if len(files) == 0 {
		return &MerkleTree{
			root:   &MerkleNode{Hash: sha256.Sum256(nil)},
			leaves: make(map[string]*MerkleNode),
		}
	}

	paths := make([]string, 0, len(files))
	for p := range files {
		paths = append(paths, p)
	}
	sort.Strings(paths)

	leaves := make(map[string]*MerkleNode, len(paths))
	nodes := make([]*MerkleNode, len(paths))
	for i, p := range paths {
		h := sha256.Sum256(files[p])
		node := &MerkleNode{
			Hash:   h,
			Path:   p,
			IsLeaf: true,
		}
		nodes[i] = node
		leaves[p] = node
	}

	root := buildLevel(nodes)
	return &MerkleTree{root: root, leaves: leaves}
}

func buildLevel(nodes []*MerkleNode) *MerkleNode {
	if len(nodes) == 1 {
		return nodes[0]
	}

	var next []*MerkleNode
	for i := 0; i < len(nodes); i += 2 {
		if i+1 >= len(nodes) {
			next = append(next, nodes[i])
			continue
		}
		combined := append(nodes[i].Hash[:], nodes[i+1].Hash[:]...)
		parent := &MerkleNode{
			Hash:  sha256.Sum256(combined),
			Left:  nodes[i],
			Right: nodes[i+1],
		}
		next = append(next, parent)
	}
	return buildLevel(next)
}

// RootHash returns the hex-encoded SHA-256 root hash representing the entire workspace state.
func (t *MerkleTree) RootHash() string {
	if t == nil || t.root == nil {
		return hex.EncodeToString(make([]byte, sha256.Size))
	}
	return hex.EncodeToString(t.root.Hash[:])
}

// Diff compares two Merkle trees and returns file paths that differ.
// A path is returned if it exists in one tree but not the other, or if
// the content hashes differ.
func Diff(local, remote *MerkleTree) []string {
	if local == nil && remote == nil {
		return nil
	}
	if local == nil {
		return allPaths(remote)
	}
	if remote == nil {
		return allPaths(local)
	}

	// Fast path: identical root hashes mean no differences.
	if local.root.Hash == remote.root.Hash {
		return nil
	}

	var changed []string
	allKeys := make(map[string]struct{})
	for k := range local.leaves {
		allKeys[k] = struct{}{}
	}
	for k := range remote.leaves {
		allKeys[k] = struct{}{}
	}

	for path := range allKeys {
		localLeaf, inLocal := local.leaves[path]
		remoteLeaf, inRemote := remote.leaves[path]

		if !inLocal || !inRemote {
			changed = append(changed, path)
			continue
		}
		if localLeaf.Hash != remoteLeaf.Hash {
			changed = append(changed, path)
		}
	}

	sort.Strings(changed)
	return changed
}

func allPaths(t *MerkleTree) []string {
	if t == nil {
		return nil
	}
	paths := make([]string, 0, len(t.leaves))
	for p := range t.leaves {
		paths = append(paths, p)
	}
	sort.Strings(paths)
	return paths
}

// PathPrefix returns all paths in the tree under the given prefix.
func (t *MerkleTree) PathPrefix(prefix string) []string {
	if t == nil {
		return nil
	}
	var result []string
	for p := range t.leaves {
		if strings.HasPrefix(p, prefix) {
			result = append(result, p)
		}
	}
	sort.Strings(result)
	return result
}

// FileCount returns the number of files tracked in the tree.
func (t *MerkleTree) FileCount() int {
	if t == nil {
		return 0
	}
	return len(t.leaves)
}
