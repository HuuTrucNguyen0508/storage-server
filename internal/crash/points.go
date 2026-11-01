package crash

type Point string

const (
	MoveAfterIntent    Point = "move.after-intent"
	MoveAfterRename    Point = "move.after-rename"
	MoveAfterCommit    Point = "move.after-commit"
	TrashAfterMeta     Point = "trash.after-meta"
	RestoreAfterCommit Point = "restore.after-commit"
	PurgeAfterMeta     Point = "purge.after-meta"
	PurgeAfterShares   Point = "purge.after-shares"
	PurgeMidRemove     Point = "purge.mid-remove"
	UploadAfterCreate  Point = "upload.after-create"
	UploadMidAppend    Point = "upload.mid-append"
	UploadAfterSync    Point = "upload.after-sync"
	UploadAfterIntent  Point = "upload.after-publish-intent"
	UploadAfterPublish Point = "upload.after-publish"
)

var All = []Point{
	MoveAfterIntent, MoveAfterRename, MoveAfterCommit,
	TrashAfterMeta, RestoreAfterCommit,
	PurgeAfterMeta, PurgeAfterShares, PurgeMidRemove,
	UploadAfterCreate, UploadMidAppend, UploadAfterSync, UploadAfterIntent, UploadAfterPublish,
}

type Fault string

const ParentFsync Fault = "move.parent-fsync"

type Gap string

const (
	GuestAfterLoad Gap = "guest.after-load"
	AdmitAfterLoad Gap = "admit.after-load"
)
