//go:build crashpoints

package upload

import (
	"context"
	"os"
	"path/filepath"
	"testing"
)

func TestRecoverySyncsDataBeforePublication(t *testing.T) {
	e := setup(t)
	ctx := context.Background()
	const id = "aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa"
	e.spool(t, id+"/meta.json", `{"path":"recovered.txt","length":4}`)
	e.spool(t, id+"/data", "data")
	t.Setenv("FAIL_AT", "upload.data-fsync")
	if err := e.m.Recover(ctx); err != nil {
		t.Fatal(err)
	}
	if _, err := os.Stat(filepath.Join(e.root, "recovered.txt")); !os.IsNotExist(err) {
		t.Fatalf("recovery published data despite fsync failure: %v", err)
	}
	t.Setenv("FAIL_AT", "")
	if err := e.m.Recover(ctx); err != nil {
		t.Fatal(err)
	}
	if got := e.read(t, "recovered.txt"); got != "data" {
		t.Fatal(got)
	}
}
