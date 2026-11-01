//go:build !crashpoints

// Package crash names every step where a crash must converge. The normal build
// compiles Hit to nothing. The harness builds with -tags crashpoints and kills
// the real binary at each Point in All.
package crash

func Hit(Point) {}
