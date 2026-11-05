// Package filetype decides, from a file name alone, which viewer shows a file
// and which Content-Type it may be served with inline.
//
// The browser-supplied type of an upload is never trusted. Only the explicit
// allowlists below are ever served inline; everything else is a download or
// plain text read by the SPA.
package filetype

import (
	"path"
	"strings"
)

// Kind is the viewer the SPA uses for a file.
type Kind string

const (
	Folder   Kind = "folder"
	Image    Kind = "image"
	Video    Kind = "video"
	Audio    Kind = "audio"
	PDF      Kind = "pdf"
	Markdown Kind = "markdown"
	JSON     Kind = "json"
	CSV      Kind = "csv"
	Code     Kind = "code"
	Text     Kind = "text"
	Archive  Kind = "archive"
	Office   Kind = "office"
	Other    Kind = "other"
)

// inline lists the only types we ever serve with an inline disposition.
var inline = map[string]string{
	".jpg": "image/jpeg", ".jpeg": "image/jpeg", ".png": "image/png", ".gif": "image/gif",
	".webp": "image/webp", ".avif": "image/avif", ".bmp": "image/bmp",
	".mp4": "video/mp4", ".m4v": "video/mp4", ".webm": "video/webm", ".ogv": "video/ogg", ".mov": "video/quicktime",
	".mp3": "audio/mpeg", ".m4a": "audio/mp4", ".aac": "audio/aac", ".wav": "audio/wav", ".flac": "audio/flac",
	".ogg": "audio/ogg", ".oga": "audio/ogg", ".opus": "audio/ogg", ".weba": "audio/webm",
}

// thumbable lists image formats the server can decode for thumbnails.
var thumbable = map[string]bool{".jpg": true, ".jpeg": true, ".png": true, ".gif": true, ".webp": true, ".bmp": true, ".tif": true, ".tiff": true}

var office = map[string]string{
	".docx": "application/vnd.openxmlformats-officedocument.wordprocessingml.document",
	".xlsx": "application/vnd.openxmlformats-officedocument.spreadsheetml.sheet",
	".pptx": "application/vnd.openxmlformats-officedocument.presentationml.presentation",
	".odt":  "application/vnd.oasis.opendocument.text",
	".ods":  "application/vnd.oasis.opendocument.spreadsheet",
	".odp":  "application/vnd.oasis.opendocument.presentation",
	".doc":  "application/msword",
	".xls":  "application/vnd.ms-excel",
	".ppt":  "application/vnd.ms-powerpoint",
	".rtf":  "application/rtf",
}

var codeExt = map[string]string{
	".go": "go", ".rs": "rust", ".py": "python", ".rb": "ruby", ".java": "java", ".kt": "kotlin", ".kts": "kotlin",
	".c": "c", ".h": "c", ".cc": "cpp", ".cpp": "cpp", ".hpp": "cpp", ".cs": "csharp", ".php": "php",
	".js": "javascript", ".mjs": "javascript", ".cjs": "javascript", ".jsx": "javascript",
	".ts": "typescript", ".tsx": "typescript", ".mts": "typescript", ".cts": "typescript",
	".css": "css", ".scss": "scss", ".less": "less", ".html": "xml", ".htm": "xml", ".xml": "xml", ".svg": "xml",
	".vue": "xml", ".svelte": "xml",
	".sh": "bash", ".bash": "bash", ".zsh": "bash", ".fish": "bash", ".ps1": "powershell",
	".sql": "sql", ".swift": "swift", ".lua": "lua", ".pl": "perl", ".r": "r", ".scala": "scala", ".dart": "dart",
	".yaml": "yaml", ".yml": "yaml", ".toml": "ini", ".ini": "ini", ".conf": "ini", ".cfg": "ini", ".properties": "properties",
	".gradle": "groovy", ".groovy": "groovy", ".tf": "hcl", ".hcl": "hcl", ".proto": "protobuf",
	".diff": "diff", ".patch": "diff", ".tex": "latex", ".mk": "makefile", ".cmake": "cmake", ".nix": "nix",
	".ex": "elixir", ".exs": "elixir", ".erl": "erlang", ".hs": "haskell", ".clj": "clojure", ".zig": "zig",
}

var codeNames = map[string]string{
	"dockerfile": "dockerfile", "containerfile": "dockerfile", "makefile": "makefile", "gnumakefile": "makefile",
	"justfile": "makefile", "cmakelists.txt": "cmake", ".gitignore": "plaintext", ".dockerignore": "plaintext",
	".editorconfig": "ini", ".env": "bash", "go.mod": "go", "go.sum": "plaintext",
}

var textExt = map[string]bool{".txt": true, ".log": true, ".text": true, ".nfo": true, ".srt": true, ".vtt": true, ".rst": true, ".adoc": true, ".org": true}

var textNames = map[string]bool{"readme": true, "license": true, "licence": true, "copying": true, "authors": true, "changelog": true, "notice": true, "todo": true}

// Info describes how to treat a file.
type Info struct {
	Kind Kind
	// Mime is a display type; it is never used for inline serving.
	Mime string
	// InlineType is the Content-Type for inline serving, empty if the file
	// must not be shown inline.
	InlineType string
	// Language is the syntax-highlighting language for code.
	Language string
	// Thumbnail reports whether the server can build an image thumbnail.
	Thumbnail bool
}

// Detect classifies a file by its name.
func Detect(name string) Info {
	lower := strings.ToLower(name)
	ext := path.Ext(lower)
	if t, ok := inline[ext]; ok {
		k := Image
		switch {
		case strings.HasPrefix(t, "video/"):
			k = Video
		case strings.HasPrefix(t, "audio/"):
			k = Audio
		}
		return Info{Kind: k, Mime: t, InlineType: t, Thumbnail: thumbable[ext]}
	}
	if thumbable[ext] {
		return Info{Kind: Image, Mime: "image/tiff", Thumbnail: true}
	}
	switch ext {
	case ".pdf":
		return Info{Kind: PDF, Mime: "application/pdf"}
	case ".md", ".markdown", ".mdown", ".mkd":
		return Info{Kind: Markdown, Mime: "text/markdown", Language: "markdown"}
	case ".json", ".geojson", ".jsonc", ".webmanifest":
		return Info{Kind: JSON, Mime: "application/json", Language: "json"}
	case ".csv":
		return Info{Kind: CSV, Mime: "text/csv"}
	case ".tsv":
		return Info{Kind: CSV, Mime: "text/tab-separated-values"}
	case ".zip", ".jar", ".apk", ".epub":
		return Info{Kind: Archive, Mime: "application/zip"}
	}
	if t, ok := office[ext]; ok {
		return Info{Kind: Office, Mime: t}
	}
	if lang, ok := codeNames[lower]; ok {
		return Info{Kind: Code, Mime: "text/plain", Language: lang}
	}
	if lang, ok := codeExt[ext]; ok {
		return Info{Kind: Code, Mime: "text/plain", Language: lang}
	}
	if textExt[ext] || textNames[strings.TrimSuffix(lower, ext)] && (ext == "" || ext == ".txt") {
		return Info{Kind: Text, Mime: "text/plain"}
	}
	return Info{Kind: Other, Mime: "application/octet-stream"}
}

// IsOffice reports whether the extension can be converted by Stirling PDF.
func IsOffice(name string) bool { _, ok := office[strings.ToLower(path.Ext(name))]; return ok }

// PreviewLabel maps a kind to the label set of storage_preview_requests_total.
func PreviewLabel(k Kind) string {
	switch k {
	case Image, Video, Audio, PDF, Markdown, Office:
		return string(k)
	case Text, Code, JSON, CSV:
		return "text"
	default:
		return "other"
	}
}

// IsTextual reports whether the SPA reads the file as text.
func IsTextual(k Kind) bool {
	switch k {
	case Text, Code, Markdown, JSON, CSV:
		return true
	}
	return false
}
