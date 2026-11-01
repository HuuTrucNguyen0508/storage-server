package api

import (
	"bytes"
	"net/http/httptest"
	"testing"
	"time"

	"storage-server/internal/media"
)

func TestThumbnailRevalidates(t *testing.T) {
	response := httptest.NewRecorder()
	response.Header().Set("Etag", "\"thumb\"")
	media.ServeThumb(&apiWriter{ResponseWriter: response}, httptest.NewRequest("GET", "/api/files/thumb", nil), bytes.NewReader([]byte("jpeg")), time.Unix(100, 0))
	if got := response.Header().Get("Cache-Control"); got != "private, no-cache" {
		t.Fatalf("thumbnail cache policy = %q, want private, no-cache", got)
	}
	response = httptest.NewRecorder()
	response.Header().Set("Etag", "\"thumb\"")
	request := httptest.NewRequest("GET", "/api/files/thumb", nil)
	request.Header.Set("If-None-Match", "\"thumb\"")
	media.ServeThumb(&apiWriter{ResponseWriter: response}, request, bytes.NewReader([]byte("jpeg")), time.Unix(100, 0))
	if response.Code != 304 {
		t.Fatalf("revalidation = %d, want 304", response.Code)
	}
}
