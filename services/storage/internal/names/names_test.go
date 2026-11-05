package names

import (
	"strings"
	"testing"
)

func TestNormalize(t *testing.T) {
	ok := map[string]string{
		"  report.pdf ":          "report.pdf",
		"café":                  "café",
		".hidden":                ".hidden",
		"日本語.txt":                "日本語.txt",
		"a..b":                   "a..b",
		strings.Repeat("é", 127): strings.Repeat("é", 127),
	}
	for in, want := range ok {
		got, err := Normalize(in)
		if err != nil || got != want {
			t.Errorf("Normalize(%q) = %q, %v; want %q", in, got, err, want)
		}
	}
	for _, bad := range []string{"", "   ", ".", "..", "a/b", `a\b`, "a\x00b", "a\nb", "a\x7fb", "x‮gpj.exe", "⁦x", strings.Repeat("a", 256), "\xff"} {
		if got, err := Normalize(bad); err == nil {
			t.Errorf("Normalize(%q) = %q, want error", bad, got)
		}
	}
}

func TestSplitPath(t *testing.T) {
	got, err := SplitPath("/photos//2024/")
	if err == nil {
		t.Fatalf("empty component accepted: %v", got)
	}
	got, err = SplitPath("photos/2024")
	if err != nil || strings.Join(got, "|") != "photos|2024" {
		t.Fatalf("SplitPath = %v, %v", got, err)
	}
	if _, err := SplitPath("a/../b"); err == nil {
		t.Fatal(".. accepted")
	}
	if got, _ := SplitPath(""); got == nil || len(got) != 0 {
		t.Fatalf("empty path = %#v", got)
	}
}

func TestNumbered(t *testing.T) {
	cases := map[string]string{"a.txt": "a (2).txt", "archive.tar.gz": "archive.tar (2).gz", ".env": ".env (2)", "noext": "noext (2)"}
	for in, want := range cases {
		if got := Numbered(in, 2); got != want {
			t.Errorf("Numbered(%q) = %q, want %q", in, got, want)
		}
	}
	long := strings.Repeat("x", 250) + ".txt"
	if got := Numbered(long, 12); len(got) > MaxBytes || !strings.HasSuffix(got, " (12).txt") {
		t.Errorf("long name numbered to %q (%d bytes)", got, len(got))
	}
}
