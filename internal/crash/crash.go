//go:build !crashpoints

package crash

func Hit(Point) {}

func Fail(Fault) error { return nil }

func Pause(Gap) {}
