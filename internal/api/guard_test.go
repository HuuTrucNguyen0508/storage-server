package api

import (
	"go/ast"
	"go/parser"
	"go/token"
	"os"
	"path/filepath"
	"regexp"
	"slices"
	"strconv"
	"strings"
	"testing"
)

// The disk package is the security boundary only if nothing goes around it.
// This fails the build when another package imports a syscall layer or calls a
// path-taking os function. thumbs and store write to the state directory, which
// holds no user input as a path, and live in files listed here.
var mayTouchOS = map[string]bool{"internal/disk": true, "internal/store": true}
var stateDirFile = map[string]bool{"internal/media/thumbs.go": true}

var pathFuncs = regexp.MustCompile(`^(Open|OpenFile|OpenRoot|OpenInRoot|Create|CreateTemp|Rename|Remove|RemoveAll|Mkdir|MkdirAll|MkdirTemp|ReadFile|WriteFile|ReadDir|Stat|Lstat|Symlink|Link|Readlink|Chmod|Chown|Truncate|DirFS)$`)

func TestOnlyDiskTouchesStorage(t *testing.T) {
	root := filepath.Join("..", "..")
	dirs, err := filepath.Glob(filepath.Join(root, "internal", "*"))
	if err != nil {
		t.Fatal(err)
	}
	checked := 0
	for _, dir := range append(dirs, filepath.Join(root, "cmd", "storage-server")) {
		rel, _ := filepath.Rel(root, dir)
		if mayTouchOS[rel] {
			continue
		}
		files, _ := filepath.Glob(filepath.Join(dir, "*.go"))
		for _, name := range files {
			frel, _ := filepath.Rel(root, name)
			if strings.HasSuffix(name, "_test.go") || stateDirFile[frel] {
				continue
			}
			checked++
			fset := token.NewFileSet()
			f, err := parser.ParseFile(fset, name, nil, 0)
			if err != nil {
				t.Fatal(err)
			}
			osAlias := ""
			for _, imp := range f.Imports {
				path, _ := strconv.Unquote(imp.Path.Value)
				switch {
				case path == "syscall" && strings.HasPrefix(rel, "cmd/"):
				case path == "syscall", strings.HasPrefix(path, "golang.org/x/sys"):
					t.Errorf("%s imports %s", frel, path)
				case path == "os":
					osAlias = "os"
				}
			}
			if osAlias == "" {
				continue
			}
			ast.Inspect(f, func(n ast.Node) bool {
				sel, ok := n.(*ast.SelectorExpr)
				if !ok {
					return true
				}
				if id, ok := sel.X.(*ast.Ident); ok && id.Name == osAlias && pathFuncs.MatchString(sel.Sel.Name) {
					t.Errorf("%s: os.%s bypasses internal/disk", fset.Position(sel.Pos()), sel.Sel.Name)
				}
				return true
			})
		}
	}
	if checked < 8 {
		t.Fatalf("checked only %d files, the walk is broken", checked)
	}
}

func TestDocumentedRoutesMatchTheTable(t *testing.T) {
	doc, err := os.ReadFile(filepath.Join("..", "..", "API.md"))
	if err != nil {
		t.Fatal(err)
	}
	row := regexp.MustCompile("(?m)^\\| `(GET|POST|HEAD|PATCH|DELETE) ([^`]+)`")
	var documented []string
	for _, m := range row.FindAllStringSubmatch(string(doc), -1) {
		documented = append(documented, m[1]+" "+m[2])
	}
	var table []string
	for _, r := range routes {
		table = append(table, r.method+" "+r.path)
	}
	slices.Sort(documented)
	slices.Sort(table)
	for _, m := range table {
		if !slices.Contains(documented, m) {
			t.Errorf("route %s is missing from API.md", m)
		}
	}
	for _, m := range documented {
		if !slices.Contains(table, m) {
			t.Errorf("API.md documents %s, which is not in the route table", m)
		}
	}
}

func TestOwnerRoutesAreAbsentFromGuestSurface(t *testing.T) {
	for _, r := range routes {
		if r.gate == Owner && r.gate.reachesGuest() {
			t.Errorf("%s %s reaches the guest listener", r.method, r.path)
		}
		if strings.HasPrefix(r.path, "/api/public/") && r.gate == Owner {
			t.Errorf("%s %s is under the public prefix with an owner gate", r.method, r.path)
		}
		if !strings.HasPrefix(r.path, "/api/public/") && r.gate != Owner && !r.ownerOnlyListener && r.path != "/healthz" {
			t.Errorf("%s %s is on the guest listener outside /api/public", r.method, r.path)
		}
	}
}
