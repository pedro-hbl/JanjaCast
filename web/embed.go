// Package web embeds the built Activity client so the server ships as a
// single binary. Run `npm run build` in web/ (or `make web`) before
// `go build` — the dist/ directory must exist at compile time.
package web

import "embed"

// Dist is the production client build.
//
//go:embed all:dist
var Dist embed.FS
