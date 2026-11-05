// Package names validates and normalizes user-supplied file and folder names.
//
// A name is only ever stored in the database and shown to people; it never
// reaches the filesystem. The rules still keep names safe to put into ZIP
// archives and Content-Disposition headers, and stop look-alike tricks.
package names

import (
	"errors"
	"fmt"
	"strings"
	"unicode"
	"unicode/utf8"

	"golang.org/x/text/unicode/norm"
)

// MaxBytes is the longest name we accept, in UTF-8 bytes.
const MaxBytes = 255

var ErrInvalid = errors.New("invalid name")

// Normalize returns the canonical form of name (Unicode NFC, trimmed) or an
// error that says why the name is refused.
func Normalize(name string) (string, error) {
	if !utf8.ValidString(name) {
		return "", fmt.Errorf("%w: not valid UTF-8", ErrInvalid)
	}
	n := norm.NFC.String(strings.TrimSpace(name))
	switch {
	case n == "":
		return "", fmt.Errorf("%w: empty", ErrInvalid)
	case n == "." || n == "..":
		return "", fmt.Errorf("%w: %q is reserved", ErrInvalid, n)
	case len(n) > MaxBytes:
		return "", fmt.Errorf("%w: longer than %d bytes", ErrInvalid, MaxBytes)
	}
	for _, r := range n {
		switch {
		case r == '/' || r == '\\':
			return "", fmt.Errorf("%w: contains a slash", ErrInvalid)
		case unicode.IsControl(r):
			return "", fmt.Errorf("%w: contains a control character", ErrInvalid)
		case isBidiControl(r):
			return "", fmt.Errorf("%w: contains a text-direction control character", ErrInvalid)
		case r == utf8.RuneError:
			return "", fmt.Errorf("%w: not valid UTF-8", ErrInvalid)
		}
	}
	return n, nil
}

// SplitPath normalizes each component of a relative folder path such as
// "photos/2024". An empty path gives no components.
func SplitPath(p string) ([]string, error) {
	p = strings.Trim(strings.ReplaceAll(p, "\\", "/"), "/")
	if p == "" {
		return []string{}, nil
	}
	parts := strings.Split(p, "/")
	if len(parts) > 64 {
		return nil, fmt.Errorf("%w: folder path is deeper than 64 levels", ErrInvalid)
	}
	out := make([]string, 0, len(parts))
	for _, part := range parts {
		n, err := Normalize(part)
		if err != nil {
			return nil, err
		}
		out = append(out, n)
	}
	return out, nil
}

// Numbered returns "name (i).ext" for i >= 1. The extension is everything
// after the last dot, unless the dot is the first character.
func Numbered(name string, i int) string {
	base, ext := name, ""
	if dot := strings.LastIndexByte(name, '.'); dot > 0 {
		base, ext = name[:dot], name[dot:]
	}
	out := fmt.Sprintf("%s (%d)%s", base, i, ext)
	for len(out) > MaxBytes && len(base) > 1 {
		_, size := utf8.DecodeLastRuneInString(base)
		base = base[:len(base)-size]
		out = fmt.Sprintf("%s (%d)%s", base, i, ext)
	}
	return out
}

func isBidiControl(r rune) bool {
	return (r >= 0x202A && r <= 0x202E) || (r >= 0x2066 && r <= 0x2069) || r == 0x200E || r == 0x200F || r == 0x061C
}
