// Package web embeds the built single-page app (pnpm build writes ui-dist/).
package web

import (
	"embed"
	"io/fs"
)

//go:embed all:ui-dist
var dist embed.FS

// FS returns the built app with ui-dist/ as its root.
func FS() fs.FS {
	sub, err := fs.Sub(dist, "ui-dist")
	if err != nil {
		panic(err)
	}
	return sub
}
