package disk

import (
	"errors"
	"slices"
	"strings"
	"testing"
)

func TestParsePath(t *testing.T) {
	for raw, want := range map[string]error{
		"":                       nil,
		"a":                      nil,
		"a/b c/d.txt":            nil,
		"ü/日本語":                  nil,
		"a/.storage-server":      nil,
		"a\\b":                   nil,
		"..":                     ErrInvalidPath,
		"a/../b":                 ErrInvalidPath,
		"./a":                    ErrInvalidPath,
		"/etc/passwd":            ErrInvalidPath,
		"a//b":                   ErrInvalidPath,
		"a/":                     ErrInvalidPath,
		"a\x00b":                 ErrInvalidPath,
		"a\nb":                   ErrInvalidPath,
		"\xff":                   ErrInvalidPath,
		strings.Repeat("x", 256): ErrInvalidPath,
		".storage-server":        ErrReserved,
		".storage-server/x":      ErrReserved,
		".Storage-SERVER/x":      ErrReserved,
	} {
		p, err := ParsePath(raw)
		if !errors.Is(err, want) || (want == nil && err != nil) {
			t.Errorf("ParsePath(%q) error = %v, want %v", raw, err, want)
		}
		if err == nil && p.String() != raw {
			t.Errorf("ParsePath(%q) = %q, it must not clean", raw, p)
		}
	}
}

func mustPath(t *testing.T, raw string) Path {
	t.Helper()
	p, err := ParsePath(raw)
	if err != nil {
		t.Fatal(err)
	}
	return p
}

func TestEntrySplitsAPath(t *testing.T) {
	if _, ok := (Path{}).Entry(); ok {
		t.Error("the root has an Entry")
	}
	e, ok := mustPath(t, "a/b/c.txt").Entry()
	if !ok || e.Dir.String() != "a/b" || e.Name.String() != "c.txt" || e.Path().String() != "a/b/c.txt" {
		t.Errorf("Entry = %+v, %v", e, ok)
	}
	e, _ = mustPath(t, "top").Entry()
	if !e.Dir.IsRoot() || e.Path().String() != "top" {
		t.Errorf("Entry(top) = %+v", e)
	}
}

func TestContains(t *testing.T) {
	for _, c := range []struct {
		p, q string
		want bool
	}{
		{"a", "a", true}, {"a", "a/b", true}, {"a", "ab", false}, {"a/b", "a", false}, {"", "a", true},
	} {
		if got := mustPath(t, c.p).Contains(mustPath(t, c.q)); got != c.want {
			t.Errorf("%q contains %q = %v", c.p, c.q, got)
		}
	}
}

func TestChildRefusesTheReservedNameOnlyAtTheRoot(t *testing.T) {
	n, _ := ParseName(".Storage-Server")
	if _, err := (Path{}).Child(n); !errors.Is(err, ErrReserved) {
		t.Errorf("root child = %v", err)
	}
	e, err := mustPath(t, "a").Child(n)
	if err != nil || e.Path().String() != "a/.Storage-Server" {
		t.Errorf("nested child = %v, %v", e, err)
	}
}

func TestLocationRoundTrip(t *testing.T) {
	for _, s := range []string{"live:", "live:a/b c", "trash:T1", "trash:T1/ü/x.txt"} {
		l, err := ParseLocation(s)
		if err != nil {
			t.Fatalf("ParseLocation(%q): %v", s, err)
		}
		if l.String() != s {
			t.Errorf("round trip %q = %q", s, l)
		}
	}
	for _, s := range []string{"", "a/b", "live:../x", "trash:", "trash:/x", "trash:T/../x"} {
		if _, err := ParseLocation(s); err == nil {
			t.Errorf("ParseLocation(%q) accepted", s)
		}
	}
	l, _ := ParseLocation("trash:T1/x")
	if _, live := l.LivePath(); live {
		t.Error("a trashed location reports a live path")
	}
	if id, rel, ok := l.Trashed(); !ok || id != "T1" || rel.String() != "x" {
		t.Errorf("Trashed = %v %v %v", id, rel, ok)
	}
}

func TestCandidates(t *testing.T) {
	collect := func(raw string, n int) []string {
		name, err := ParseName(raw)
		if err != nil {
			t.Fatal(err)
		}
		var got []string
		for c := range Candidates(name) {
			if got = append(got, c.String()); len(got) == n {
				break
			}
		}
		return got
	}
	if got, want := collect("a.tar.gz", 3), []string{"a.tar.gz", "a.tar (1).gz", "a.tar (2).gz"}; !slices.Equal(got, want) {
		t.Errorf("got %v", got)
	}
	if got, want := collect(".bashrc", 2), []string{".bashrc", ".bashrc (1)"}; !slices.Equal(got, want) {
		t.Errorf("got %v", got)
	}
	long := strings.Repeat("é", 126) + ".x"
	got := collect(long, 2)
	if len(got[1]) > 255 || !strings.HasSuffix(got[1], " (1).x") {
		t.Errorf("long candidate = %q (%d bytes)", got[1], len(got[1]))
	}
}
