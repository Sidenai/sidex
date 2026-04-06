use std::collections::HashMap;
use wasm_bindgen::prelude::*;

#[wasm_bindgen]
pub struct TfIdfEngine {
    chunk_count: u32,
    chunk_occurrences: HashMap<String, u32>,
    documents: HashMap<String, Vec<Vec<(String, u32)>>>,
}

fn is_letter(c: char) -> bool {
    c.is_alphabetic()
}

fn is_letter_or_digit(c: char) -> bool {
    c.is_alphanumeric()
}

fn split_terms(input: &str) -> Vec<String> {
    let mut terms = Vec::new();
    let lower = input.to_lowercase();
    let chars: Vec<char> = lower.chars().collect();
    let len = chars.len();
    let mut i = 0;

    while i < len {
        if !is_letter(chars[i]) {
            i += 1;
            continue;
        }
        let start = i;
        while i < len && is_letter_or_digit(chars[i]) {
            i += 1;
        }
        let word_len = i - start;
        if word_len >= 3 {
            let word: String = chars[start..i].iter().collect();
            terms.push(word.clone());

            let original_chars: Vec<char> = input[start..start + word_len].chars().collect();
            let mut parts = Vec::new();
            let mut part_start = 0;
            for j in 1..original_chars.len() {
                if original_chars[j].is_uppercase() && original_chars[j - 1].is_lowercase() {
                    parts.push(part_start);
                    part_start = j;
                }
            }
            parts.push(part_start);

            if parts.len() > 1 {
                for &ps in &parts {
                    let pe = parts
                        .iter()
                        .find(|&&p| p > ps)
                        .copied()
                        .unwrap_or(original_chars.len());
                    if pe - ps >= 3 {
                        let part: String = original_chars[ps..pe]
                            .iter()
                            .collect::<String>()
                            .to_lowercase();
                        if part.chars().filter(|c| c.is_alphabetic()).count() >= 3 {
                            terms.push(part);
                        }
                    }
                }
            }
        }
    }
    terms
}

fn term_frequencies(input: &str) -> Vec<(String, u32)> {
    let terms = split_terms(input);
    let mut tf: HashMap<String, u32> = HashMap::new();
    for t in terms {
        *tf.entry(t).or_insert(0) += 1;
    }
    tf.into_iter().collect()
}

#[wasm_bindgen]
impl TfIdfEngine {
    #[wasm_bindgen(constructor)]
    pub fn new() -> Self {
        TfIdfEngine {
            chunk_count: 0,
            chunk_occurrences: HashMap::new(),
            documents: HashMap::new(),
        }
    }

    pub fn update_document(&mut self, key: &str, chunks_json: &str) {
        self.delete_document(key);

        let text_chunks: Vec<String> = match parse_string_array(chunks_json) {
            Some(v) => v,
            None => return,
        };

        let mut doc_chunks = Vec::with_capacity(text_chunks.len());
        for text in &text_chunks {
            let tf = term_frequencies(text);
            for (term, _) in &tf {
                *self.chunk_occurrences.entry(term.clone()).or_insert(0) += 1;
            }
            doc_chunks.push(tf);
        }
        self.chunk_count += doc_chunks.len() as u32;
        self.documents.insert(key.to_string(), doc_chunks);
    }

    pub fn delete_document(&mut self, key: &str) {
        if let Some(chunks) = self.documents.remove(key) {
            self.chunk_count -= chunks.len() as u32;
            for chunk in &chunks {
                for (term, _) in chunk {
                    if let Some(count) = self.chunk_occurrences.get_mut(term) {
                        if *count <= 1 {
                            self.chunk_occurrences.remove(term);
                        } else {
                            *count -= 1;
                        }
                    }
                }
            }
        }
    }

    pub fn calculate_scores(&self, query: &str) -> String {
        let query_tf = term_frequencies(query);
        let query_embedding = self.compute_tfidf(&query_tf);

        let mut results: Vec<(String, f64)> = Vec::new();

        for (key, chunks) in &self.documents {
            for chunk in chunks {
                let score = self.dot_product(chunk, &query_embedding);
                if score > 0.0 {
                    results.push((key.clone(), score));
                }
            }
        }

        let mut json = String::from("[");
        for (i, (key, score)) in results.iter().enumerate() {
            if i > 0 {
                json.push(',');
            }
            json.push_str(&format!(
                "{{\"key\":\"{}\",\"score\":{}}}",
                escape_json_string(key),
                score
            ));
        }
        json.push(']');
        json
    }

    fn compute_idf(&self, term: &str) -> f64 {
        let occ = *self.chunk_occurrences.get(term).unwrap_or(&0) as f64;
        if occ > 0.0 {
            ((self.chunk_count as f64 + 1.0) / occ).ln()
        } else {
            0.0
        }
    }

    fn compute_tfidf(&self, tf: &[(String, u32)]) -> Vec<(String, f64)> {
        let mut embedding = Vec::new();
        for (word, count) in tf {
            let idf = self.compute_idf(word);
            if idf > 0.0 {
                embedding.push((word.clone(), *count as f64 * idf));
            }
        }
        embedding
    }

    fn dot_product(&self, chunk_tf: &[(String, u32)], query_embedding: &[(String, f64)]) -> f64 {
        let chunk_map: HashMap<&str, u32> = chunk_tf.iter().map(|(k, v)| (k.as_str(), *v)).collect();
        let mut sum = 0.0;
        for (term, q_tfidf) in query_embedding {
            if let Some(&tf) = chunk_map.get(term.as_str()) {
                let idf = self.compute_idf(term);
                sum += (tf as f64 * idf) * q_tfidf;
            }
        }
        sum
    }
}

fn parse_string_array(json: &str) -> Option<Vec<String>> {
    let trimmed = json.trim();
    if !trimmed.starts_with('[') || !trimmed.ends_with(']') {
        return None;
    }
    let inner = &trimmed[1..trimmed.len() - 1];
    if inner.trim().is_empty() {
        return Some(Vec::new());
    }

    let mut result = Vec::new();
    let mut chars = inner.chars().peekable();

    loop {
        while chars.peek().map_or(false, |c| c.is_whitespace()) {
            chars.next();
        }
        if chars.peek().is_none() {
            break;
        }
        if *chars.peek()? != '"' {
            return None;
        }
        chars.next();
        let mut s = String::new();
        loop {
            match chars.next()? {
                '\\' => {
                    let escaped = chars.next()?;
                    match escaped {
                        '"' | '\\' | '/' => s.push(escaped),
                        'n' => s.push('\n'),
                        'r' => s.push('\r'),
                        't' => s.push('\t'),
                        _ => {
                            s.push('\\');
                            s.push(escaped);
                        }
                    }
                }
                '"' => break,
                c => s.push(c),
            }
        }
        result.push(s);

        while chars.peek().map_or(false, |c| c.is_whitespace()) {
            chars.next();
        }
        match chars.peek() {
            Some(',') => {
                chars.next();
            }
            Some(_) => return None,
            None => break,
        }
    }
    Some(result)
}

fn escape_json_string(s: &str) -> String {
    let mut escaped = String::with_capacity(s.len());
    for c in s.chars() {
        match c {
            '"' => escaped.push_str("\\\""),
            '\\' => escaped.push_str("\\\\"),
            '\n' => escaped.push_str("\\n"),
            '\r' => escaped.push_str("\\r"),
            '\t' => escaped.push_str("\\t"),
            c if (c as u32) < 0x20 => escaped.push_str(&format!("\\u{:04x}", c as u32)),
            _ => escaped.push(c),
        }
    }
    escaped
}
