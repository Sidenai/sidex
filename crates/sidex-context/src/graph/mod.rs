pub mod builder;
pub mod expansion;

use std::collections::{HashMap, HashSet, VecDeque};

use serde::{Deserialize, Serialize};

#[derive(Debug, Clone, Serialize, Deserialize, PartialEq, Eq, Hash)]
pub enum EdgeKind {
    Calls,
    Imports,
    Inherits,
    Implements,
    Contains,
    References,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct GraphNode {
    pub chunk_id: String,
    pub name: String,
    pub kind: String,
    pub file_path: String,
    pub edges: Vec<Edge>,
    /// Fast lookup set for O(1) dedup checks during graph construction.
    /// Not serialized — rebuilt on deserialization if needed.
    #[serde(skip)]
    edge_set: HashSet<(String, EdgeKind)>,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct Edge {
    pub target_id: String,
    pub kind: EdgeKind,
}

#[derive(Debug, Default)]
pub struct CodeGraph {
    pub nodes: HashMap<String, GraphNode>,
    /// Reverse index: target_chunk_id → [(source_chunk_id, EdgeKind)]
    pub reverse: HashMap<String, Vec<(String, EdgeKind)>>,
}

impl CodeGraph {
    pub fn new() -> Self {
        Self::default()
    }

    pub fn add_node(&mut self, node: GraphNode) {
        self.nodes.insert(node.chunk_id.clone(), node);
    }

    pub fn add_edge(&mut self, source_id: &str, target_id: &str, kind: EdgeKind) {
        if let Some(node) = self.nodes.get_mut(source_id) {
            let key = (target_id.to_string(), kind.clone());
            if node.edge_set.insert(key) {
                node.edges.push(Edge {
                    target_id: target_id.to_string(),
                    kind: kind.clone(),
                });
                self.reverse
                    .entry(target_id.to_string())
                    .or_default()
                    .push((source_id.to_string(), kind));
            }
        }
    }

    /// Shrink internal allocations to release excess memory after graph construction.
    pub fn shrink_to_fit(&mut self) {
        for node in self.nodes.values_mut() {
            node.edges.shrink_to_fit();
            node.edge_set.shrink_to_fit();
        }
        self.reverse.shrink_to_fit();
        for v in self.reverse.values_mut() {
            v.shrink_to_fit();
        }
    }

    /// All nodes directly connected (outgoing + incoming) with their edge kind.
    pub fn neighbors(&self, chunk_id: &str) -> Vec<(&GraphNode, EdgeKind)> {
        let mut result = Vec::new();

        if let Some(node) = self.nodes.get(chunk_id) {
            for edge in &node.edges {
                if let Some(target) = self.nodes.get(&edge.target_id) {
                    result.push((target, edge.kind.clone()));
                }
            }
        }

        if let Some(rev) = self.reverse.get(chunk_id) {
            for (src_id, kind) in rev {
                if let Some(src) = self.nodes.get(src_id) {
                    result.push((src, kind.clone()));
                }
            }
        }

        result
    }

    /// BFS to collect all nodes reachable within `max_depth` hops.
    pub fn neighborhood(&self, chunk_id: &str, max_depth: usize) -> Vec<&GraphNode> {
        let mut visited = HashSet::new();
        let mut queue = VecDeque::new();

        visited.insert(chunk_id.to_string());
        queue.push_back((chunk_id.to_string(), 0usize));

        let mut result = Vec::new();

        while let Some((current_id, depth)) = queue.pop_front() {
            if depth > 0 {
                if let Some(node) = self.nodes.get(&current_id) {
                    result.push(node);
                }
            }

            if depth >= max_depth {
                continue;
            }

            // Outgoing edges
            if let Some(node) = self.nodes.get(&current_id) {
                for edge in &node.edges {
                    if visited.insert(edge.target_id.clone()) {
                        queue.push_back((edge.target_id.clone(), depth + 1));
                    }
                }
            }

            // Incoming edges
            if let Some(rev) = self.reverse.get(&current_id) {
                for (src_id, _) in rev {
                    if visited.insert(src_id.clone()) {
                        queue.push_back((src_id.clone(), depth + 1));
                    }
                }
            }
        }

        result
    }

    pub fn node_count(&self) -> usize {
        self.nodes.len()
    }

    pub fn edge_count(&self) -> usize {
        self.nodes.values().map(|n| n.edges.len()).sum()
    }
}
