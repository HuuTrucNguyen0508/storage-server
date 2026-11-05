package server

import "testing"

func TestRedactPath(t *testing.T) {
	cases := map[string]string{
		"/s/abc123":                       "/s/{token}",
		"/s/abc123/sub":                   "/s/{token}/sub",
		"/api/public/tok/nodes/x/content": "/api/public/{token}/nodes/x/content",
		"/api/public/tok":                 "/api/public/{token}",
		"/api/nodes/x":                    "/api/nodes/x",
		"/sx/abc":                         "/sx/abc",
	}
	for in, want := range cases {
		if got := RedactPath(in); got != want {
			t.Errorf("RedactPath(%q) = %q, want %q", in, got, want)
		}
	}
	for p, want := range map[string]bool{"/s/x": true, "/sx": false, "/assets/a.js": true, "/assetsx": false, "/favicon.svg": true, "/favicon.svgx": false, "/api/publicx": false, "/": false} {
		if isPublicPath(p) != want {
			t.Errorf("isPublicPath(%q) != %v", p, want)
		}
	}
}
