package tools

import (
	"encoding/base64"
	"encoding/binary"
	"encoding/json"
	"fmt"
	"os"
	"path/filepath"
	"strings"
)

// imageRead is kept as a legacy executor for older in-flight sessions. New
// model requests should use read_file, which routes image paths through the
// same readImageFile helper.
func (r *Registry) imageRead(args map[string]interface{}) ExecutionResult {
	p, err := r.resolveReadablePath(str(args, "path"))
	if err != nil {
		return ExecutionResult{Error: err.Error()}
	}

	maxSize := intOr(args, "max_size", 10*1024*1024)
	return readImageFile(p, maxSize)
}

func readImageFile(p string, maxSize int) ExecutionResult {
	info, err := os.Stat(p)
	if err != nil {
		return ExecutionResult{Error: "cannot stat file: " + err.Error()}
	}
	if info.Size() > int64(maxSize) {
		return ExecutionResult{Error: fmt.Sprintf("file is %d bytes, exceeds max_size of %d", info.Size(), maxSize)}
	}

	data, err := os.ReadFile(p)
	if err != nil {
		return ExecutionResult{Error: "cannot read file: " + err.Error()}
	}

	ext := strings.ToLower(filepath.Ext(p))
	mime := extensionToMime(ext)
	if mime == "" {
		return ExecutionResult{Error: fmt.Sprintf("unsupported image extension: %s (supported: .png, .jpg, .jpeg, .gif, .webp)", ext)}
	}

	result := map[string]interface{}{
		"mime_type":   mime,
		"base64_data": base64.StdEncoding.EncodeToString(data),
		"file_size":   len(data),
	}

	if dims := detectDimensions(data, ext); dims != nil {
		result["dimensions"] = dims
	}

	out, _ := json.Marshal(result)
	return ExecutionResult{Output: string(out)}
}

func isSupportedImagePath(path string) bool {
	return extensionToMime(strings.ToLower(filepath.Ext(path))) != ""
}

func extensionToMime(ext string) string {
	switch ext {
	case ".png":
		return "image/png"
	case ".jpg", ".jpeg":
		return "image/jpeg"
	case ".gif":
		return "image/gif"
	case ".webp":
		return "image/webp"
	default:
		return ""
	}
}

func detectDimensions(data []byte, ext string) map[string]int {
	switch ext {
	case ".png":
		return pngDimensions(data)
	case ".jpg", ".jpeg":
		return jpegDimensions(data)
	default:
		return nil
	}
}

// PNG: width and height are stored in the IHDR chunk at bytes 16-23.
func pngDimensions(data []byte) map[string]int {
	if len(data) < 24 {
		return nil
	}
	// PNG signature: 137 80 78 71 13 10 26 10
	if data[0] != 0x89 || data[1] != 0x50 || data[2] != 0x4E || data[3] != 0x47 {
		return nil
	}
	w := int(binary.BigEndian.Uint32(data[16:20]))
	h := int(binary.BigEndian.Uint32(data[20:24]))
	if w <= 0 || h <= 0 {
		return nil
	}
	return map[string]int{"width": w, "height": h}
}

// JPEG: scan for SOF0 (0xFFC0) or SOF2 (0xFFC2) marker to extract dimensions.
func jpegDimensions(data []byte) map[string]int {
	if len(data) < 2 || data[0] != 0xFF || data[1] != 0xD8 {
		return nil
	}
	i := 2
	for i+1 < len(data) {
		if data[i] != 0xFF {
			i++
			continue
		}
		marker := data[i+1]
		if marker == 0xC0 || marker == 0xC2 {
			if i+9 >= len(data) {
				return nil
			}
			h := int(binary.BigEndian.Uint16(data[i+5 : i+7]))
			w := int(binary.BigEndian.Uint16(data[i+7 : i+9]))
			if w <= 0 || h <= 0 {
				return nil
			}
			return map[string]int{"width": w, "height": h}
		}
		if i+3 >= len(data) {
			return nil
		}
		segLen := int(binary.BigEndian.Uint16(data[i+2 : i+4]))
		i += 2 + segLen
	}
	return nil
}
