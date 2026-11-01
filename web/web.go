// Package web embeds the built frontend, which is a separate design task.
package web

import "embed"

//go:embed all:dist
var Dist embed.FS
