package api

import (
	"net/http"

	"storage-server/internal/access"
)

type Gate int

const (
	Public Gate = iota
	Owner
	GuestOpen
	GuestBrowse
	GuestFetch
	GuestDrop
)

func (g Gate) reachesGuest() bool { return g != Owner }

func (g Gate) act() access.Act {
	switch g {
	case GuestFetch:
		return access.Fetch
	case GuestDrop:
		return access.Upload
	}
	return access.Browse
}

type route struct {
	method            string
	path              string
	gate              Gate
	serve             func(*API, http.ResponseWriter, *http.Request, *call)
	stream            bool
	ownerOnlyListener bool
}

var routes = []route{
	{method: "GET", path: "/api/session", gate: Public, serve: (*API).session, ownerOnlyListener: true},
	{method: "POST", path: "/api/setup", gate: Public, serve: (*API).setup, ownerOnlyListener: true},
	{method: "POST", path: "/api/login", gate: Public, serve: (*API).login, ownerOnlyListener: true},
	{method: "POST", path: "/api/logout", gate: Owner, serve: (*API).logout},
	{method: "POST", path: "/api/account/password", gate: Owner, serve: (*API).changePassword},
	{method: "GET", path: "/api/sessions", gate: Owner, serve: (*API).sessions},
	{method: "DELETE", path: "/api/sessions/{id}", gate: Owner, serve: (*API).revokeSession},

	{method: "GET", path: "/api/files", gate: Owner, serve: (*API).list},
	{method: "POST", path: "/api/files/folder", gate: Owner, serve: (*API).mkdir},
	{method: "POST", path: "/api/files/rename", gate: Owner, serve: (*API).rename},
	{method: "POST", path: "/api/files/move", gate: Owner, serve: (*API).move},
	{method: "POST", path: "/api/files/trash", gate: Owner, serve: (*API).trash},
	{method: "GET", path: "/api/files/content", gate: Owner, serve: (*API).content, stream: true},
	{method: "GET", path: "/api/files/thumb", gate: Owner, serve: (*API).thumb},
	{method: "POST", path: "/api/files/zip", gate: Owner, serve: (*API).zip, stream: true},
	{method: "GET", path: "/api/search", gate: Owner, serve: (*API).search, stream: true},
	{method: "GET", path: "/api/trash", gate: Owner, serve: (*API).listTrash},
	{method: "DELETE", path: "/api/trash", gate: Owner, serve: (*API).emptyTrash},
	{method: "POST", path: "/api/trash/{id}/restore", gate: Owner, serve: (*API).restore},
	{method: "DELETE", path: "/api/trash/{id}", gate: Owner, serve: (*API).purge},

	{method: "GET", path: "/api/shares", gate: Owner, serve: (*API).listShares},
	{method: "POST", path: "/api/shares", gate: Owner, serve: (*API).createShare},
	{method: "DELETE", path: "/api/shares/{id}", gate: Owner, serve: (*API).revokeShare},

	{method: "POST", path: "/api/uploads", gate: Owner, serve: (*API).uploadCreate},
	{method: "HEAD", path: "/api/uploads/{id}", gate: Owner, serve: (*API).uploadHead},
	{method: "PATCH", path: "/api/uploads/{id}", gate: Owner, serve: (*API).uploadPatch, stream: true},
	{method: "DELETE", path: "/api/uploads/{id}", gate: Owner, serve: (*API).uploadDelete},

	{method: "GET", path: "/api/public/{token}", gate: Public, serve: (*API).describe},
	{method: "POST", path: "/api/public/{token}/open", gate: GuestOpen, serve: (*API).open},
	{method: "GET", path: "/api/public/{token}/files", gate: GuestBrowse, serve: (*API).list},
	{method: "GET", path: "/api/public/{token}/thumb", gate: GuestBrowse, serve: (*API).thumb},
	{method: "GET", path: "/api/public/{token}/content", gate: GuestFetch, serve: (*API).content, stream: true},
	{method: "POST", path: "/api/public/{token}/zip", gate: GuestFetch, serve: (*API).zip, stream: true},
	{method: "POST", path: "/api/public/{token}/uploads", gate: GuestDrop, serve: (*API).uploadCreate},
	{method: "HEAD", path: "/api/public/{token}/uploads/{id}", gate: GuestDrop, serve: (*API).uploadHead},
	{method: "PATCH", path: "/api/public/{token}/uploads/{id}", gate: GuestDrop, serve: (*API).uploadPatch, stream: true},
	{method: "DELETE", path: "/api/public/{token}/uploads/{id}", gate: GuestDrop, serve: (*API).uploadDelete},

	{method: "GET", path: "/healthz", gate: Public, serve: (*API).healthz},
}
