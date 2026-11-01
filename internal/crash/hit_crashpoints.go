//go:build crashpoints

package crash

// Hit sends SIGKILL to this process when CRASH_AT names the point.
func Hit(p Point) { panic("not implemented") }
