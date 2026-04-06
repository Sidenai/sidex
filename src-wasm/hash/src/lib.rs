use wasm_bindgen::prelude::*;

const BLOCK_SIZE: usize = 64;

#[wasm_bindgen]
pub struct Sha1 {
    h: [u32; 5],
    buf: [u8; BLOCK_SIZE],
    buf_len: usize,
    total_len: u64,
}

#[wasm_bindgen]
impl Sha1 {
    #[wasm_bindgen(constructor)]
    pub fn new() -> Self {
        Sha1 {
            h: [0x67452301, 0xEFCDAB89, 0x98BADCFE, 0x10325476, 0xC3D2E1F0],
            buf: [0u8; BLOCK_SIZE],
            buf_len: 0,
            total_len: 0,
        }
    }

    pub fn update_str(&mut self, input: &str) {
        self.update_bytes(input.as_bytes());
    }

    pub fn update_bytes(&mut self, data: &[u8]) {
        let mut offset = 0;
        let len = data.len();

        if self.buf_len > 0 {
            let space = BLOCK_SIZE - self.buf_len;
            let fill = len.min(space);
            self.buf[self.buf_len..self.buf_len + fill].copy_from_slice(&data[..fill]);
            self.buf_len += fill;
            offset += fill;

            if self.buf_len == BLOCK_SIZE {
                let block: [u8; BLOCK_SIZE] = self.buf;
                self.compress(&block);
                self.total_len += BLOCK_SIZE as u64;
                self.buf_len = 0;
            }
        }

        while offset + BLOCK_SIZE <= len {
            let block: [u8; BLOCK_SIZE] = data[offset..offset + BLOCK_SIZE].try_into().unwrap();
            self.compress(&block);
            self.total_len += BLOCK_SIZE as u64;
            offset += BLOCK_SIZE;
        }

        if offset < len {
            let remaining = len - offset;
            self.buf[..remaining].copy_from_slice(&data[offset..]);
            self.buf_len = remaining;
        }
    }

    pub fn digest(&mut self) -> String {
        self.total_len += self.buf_len as u64;
        let ml = self.total_len * 8;

        self.buf[self.buf_len] = 0x80;
        self.buf_len += 1;

        if self.buf_len > 56 {
            for i in self.buf_len..BLOCK_SIZE {
                self.buf[i] = 0;
            }
            let block: [u8; BLOCK_SIZE] = self.buf;
            self.compress(&block);
            self.buf = [0u8; BLOCK_SIZE];
        } else {
            for i in self.buf_len..56 {
                self.buf[i] = 0;
            }
        }

        self.buf[56] = (ml >> 56) as u8;
        self.buf[57] = (ml >> 48) as u8;
        self.buf[58] = (ml >> 40) as u8;
        self.buf[59] = (ml >> 32) as u8;
        self.buf[60] = (ml >> 24) as u8;
        self.buf[61] = (ml >> 16) as u8;
        self.buf[62] = (ml >> 8) as u8;
        self.buf[63] = ml as u8;

        let block: [u8; BLOCK_SIZE] = self.buf;
        self.compress(&block);

        let mut out = String::with_capacity(40);
        for &word in &self.h {
            out.push_str(&format!("{:08x}", word));
        }
        out
    }

    fn compress(&mut self, block: &[u8; BLOCK_SIZE]) {
        let mut w = [0u32; 80];
        for i in 0..16 {
            w[i] = u32::from_be_bytes([
                block[i * 4],
                block[i * 4 + 1],
                block[i * 4 + 2],
                block[i * 4 + 3],
            ]);
        }
        for i in 16..80 {
            w[i] = (w[i - 3] ^ w[i - 8] ^ w[i - 14] ^ w[i - 16]).rotate_left(1);
        }

        let [mut a, mut b, mut c, mut d, mut e] = self.h;

        for i in 0..80 {
            let (f, k) = match i {
                0..=19 => ((b & c) | ((!b) & d), 0x5A827999u32),
                20..=39 => (b ^ c ^ d, 0x6ED9EBA1u32),
                40..=59 => ((b & c) | (b & d) | (c & d), 0x8F1BBCDCu32),
                _ => (b ^ c ^ d, 0xCA62C1D6u32),
            };

            let temp = a
                .rotate_left(5)
                .wrapping_add(f)
                .wrapping_add(e)
                .wrapping_add(k)
                .wrapping_add(w[i]);
            e = d;
            d = c;
            c = b.rotate_left(30);
            b = a;
            a = temp;
        }

        self.h[0] = self.h[0].wrapping_add(a);
        self.h[1] = self.h[1].wrapping_add(b);
        self.h[2] = self.h[2].wrapping_add(c);
        self.h[3] = self.h[3].wrapping_add(d);
        self.h[4] = self.h[4].wrapping_add(e);
    }
}

#[wasm_bindgen]
pub fn sha1_hash(input: &str) -> String {
    let mut sha = Sha1::new();
    sha.update_str(input);
    sha.digest()
}
