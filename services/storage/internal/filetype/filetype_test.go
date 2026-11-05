package filetype

import "testing"

func TestDetect(t *testing.T) {
	cases := []struct {
		name   string
		kind   Kind
		inline string
	}{
		{"a.JPG", Image, "image/jpeg"}, {"b.png", Image, "image/png"}, {"c.svg", Code, ""}, {"d.html", Code, ""},
		{"e.mp4", Video, "video/mp4"}, {"f.mp3", Audio, "audio/mpeg"}, {"g.pdf", PDF, ""}, {"h.md", Markdown, ""},
		{"i.json", JSON, ""}, {"j.csv", CSV, ""}, {"k.zip", Archive, ""}, {"l.docx", Office, ""}, {"m.go", Code, ""},
		{"Dockerfile", Code, ""}, {"README", Text, ""}, {"notes.txt", Text, ""}, {"x.exe", Other, ""}, {"photo.tiff", Image, ""},
		{"page.xhtml", Other, ""},
	}
	for _, c := range cases {
		got := Detect(c.name)
		if got.Kind != c.kind || got.InlineType != c.inline {
			t.Errorf("Detect(%q) = %s/%q, want %s/%q", c.name, got.Kind, got.InlineType, c.kind, c.inline)
		}
	}
	// Nothing script-capable is ever inline.
	for _, n := range []string{"a.html", "a.htm", "a.svg", "a.xml", "a.xhtml", "a.js", "a.mjs", "a.pdf", "a.swf"} {
		if Detect(n).InlineType != "" {
			t.Errorf("%s is inline", n)
		}
	}
}
