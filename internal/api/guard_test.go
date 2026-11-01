package api

import (
	"fmt"
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
// path-taking function. thumbs and store write to the state directory, which
// holds no user input as a path, and live in files listed here.
var mayTouchOS = map[string]bool{"internal/disk": true, "internal/store": true}
var stateDirFile = map[string]bool{"internal/media/thumbs.go": true}

// pathFuncs lists, per package, what takes a path string. The key is the import
// path, so a renamed import cannot hide a call.
var pathFuncs = map[string]*regexp.Regexp{
	"os":            regexp.MustCompile(`^(Open|OpenFile|OpenRoot|OpenInRoot|Create|CreateTemp|Rename|Remove|RemoveAll|Mkdir|MkdirAll|MkdirTemp|ReadFile|WriteFile|ReadDir|Stat|Lstat|Symlink|Link|Readlink|Chmod|Chown|Lchown|Chtimes|Truncate|DirFS|CopyFS)$`),
	"io/ioutil":     regexp.MustCompile(`^(ReadFile|WriteFile|ReadDir|TempFile|TempDir)$`),
	"path/filepath": regexp.MustCompile(`^(Walk|WalkDir|Glob|EvalSymlinks)$`),
	"net/http":      regexp.MustCompile(`^(ServeFile|Dir)$`),
}

// violations scans one file. It resolves each import to its real path before
// looking at a call, and it treats a dot import of a watched package as a
// violation, because no selector would be left to inspect.
func violations(filename string, src any, syscallAllowed bool) ([]string, error) {
	fset := token.NewFileSet()
	f, err := parser.ParseFile(fset, filename, src, 0)
	if err != nil {
		return nil, err
	}
	var found []string
	watched := map[string]string{}
	for _, imp := range f.Imports {
		path, err := strconv.Unquote(imp.Path.Value)
		if err != nil {
			return nil, err
		}
		if path == "syscall" || strings.HasPrefix(path, "golang.org/x/sys") {
			if !(syscallAllowed && path == "syscall") {
				found = append(found, fmt.Sprintf("%s imports %s", filename, path))
			}
			continue
		}
		if _, ok := pathFuncs[path]; !ok {
			continue
		}
		local := path[strings.LastIndexByte(path, '/')+1:]
		if imp.Name != nil {
			local = imp.Name.Name
		}
		if local == "." {
			found = append(found, fmt.Sprintf("%s dot-imports %s", filename, path))
			continue
		}
		watched[local] = path
	}
	ast.Inspect(f, func(n ast.Node) bool {
		sel, ok := n.(*ast.SelectorExpr)
		if !ok {
			return true
		}
		id, ok := sel.X.(*ast.Ident)
		if !ok || id.Obj != nil {
			return true
		}
		if path, ok := watched[id.Name]; ok && pathFuncs[path].MatchString(sel.Sel.Name) {
			found = append(found, fmt.Sprintf("%s: %s.%s bypasses internal/disk", fset.Position(sel.Pos()), path, sel.Sel.Name))
		}
		return true
	})
	return found, nil
}

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
			found, err := violations(name, nil, strings.HasPrefix(rel, "cmd/"))
			if err != nil {
				t.Fatal(err)
			}
			for _, v := range found {
				t.Error(v)
			}
		}
	}
	if checked < 15 {
		t.Fatalf("checked only %d files, the walk is broken", checked)
	}
}

func TestGuardSeesThroughAliases(t *testing.T) {
	for name, c := range map[string]struct {
		src  string
		want string
	}{
		"plain":    {"package p; import \"os\"; var _, _ = os.Open(\"x\")", "os.Open bypasses"},
		"renamed":  {"package p; import o \"os\"; var _, _ = o.Open(\"x\")", "os.Open bypasses"},
		"value":    {"package p; import o \"os\"; var f = o.ReadFile", "os.ReadFile bypasses"},
		"dot":      {"package p; import . \"os\"; var _, _ = Open(\"x\")", "dot-imports os"},
		"ioutil":   {"package p; import q \"io/ioutil\"; var _, _ = q.ReadFile(\"x\")", "io/ioutil.ReadFile bypasses"},
		"filepath": {"package p; import \"path/filepath\"; var _ = filepath.WalkDir", "path/filepath.WalkDir bypasses"},
		"http":     {"package p; import h \"net/http\"; var _ = h.ServeFile", "net/http.ServeFile bypasses"},
		"syscall":  {"package p; import s \"syscall\"; var _ = s.Open", "imports syscall"},
		"x/sys":    {"package p; import u \"golang.org/x/sys/unix\"; var _ = u.Open", "imports golang.org/x/sys/unix"},
	} {
		found, err := violations(name+".go", c.src, false)
		if err != nil {
			t.Fatal(err)
		}
		if len(found) != 1 || !strings.Contains(found[0], c.want) {
			t.Errorf("%s: got %v, want one finding with %q", name, found, c.want)
		}
	}
	clean := "package p; import \"os\"; var _ = os.Getenv(\"x\")"
	if found, err := violations("clean.go", clean, false); err != nil || len(found) != 0 {
		t.Errorf("clean file: %v, %v", found, err)
	}
	shadowed := "package p; import \"os\"; type t struct{}; func (t) Open() {}; func f(os t) { os.Open() }; var _ = os.Getenv"
	if found, err := violations("shadow.go", shadowed, false); err != nil || len(found) != 0 {
		t.Errorf("shadowed name: %v, %v", found, err)
	}
}

func TestDocumentedRoutesMatchTheTable(t *testing.T) {
	doc, err := os.ReadFile(filepath.Join("..", "..", "docs", "design", "API.md"))
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
