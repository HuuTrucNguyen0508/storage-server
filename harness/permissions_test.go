//go:build harness

package harness

import (
	"os"
	"path/filepath"
	"testing"
)

func TestPrivateStateModes(t *testing.T) {
	s := start(t)
	for _, name := range []string{"state.db", "state.db-wal"} {
		st, err := os.Stat(filepath.Join(s.state, name))
		if err != nil {
			t.Fatal(err)
		}
		if st.Mode().Perm() != 0600 {
			t.Errorf("%s mode = %o, want 600", name, st.Mode().Perm())
		}
	}
	st, err := os.Stat(s.state)
	if err != nil {
		t.Fatal(err)
	}
	if st.Mode().Perm() != 0700 {
		t.Errorf("state directory mode = %o, want 700", st.Mode().Perm())
	}
}
