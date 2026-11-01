package disk

import (
	"errors"
	"fmt"
	"strconv"

	"golang.org/x/sys/unix"
)

// Disk owns the storage root. Files is what the API can name. Trash and Spool
// are private areas with one owner each: vault owns Trash, upload owns Spool.
type Disk struct {
	Files *Tree
	Trash *Tree
	Spool *Tree
}

var filesystems = map[int64]string{
	0x9123683E: "btrfs", 0xEF53: "ext4", 0x01021994: "tmpfs", 0x58465342: "xfs",
	0x794C7630: "overlayfs", 0x6969: "nfs", 0x65735546: "fuse", 0xF2F52010: "f2fs",
	0x2FC12FC1: "zfs", 0x2011BAB0: "exfat", 0x7366746E: "ntfs3", 0x4D44: "vfat",
	0xFF534D42: "cifs", 0xFE534D42: "smb2", 0x01021997: "9p",
}

func filesystemName(fd int) string {
	var fs unix.Statfs_t
	if err := unix.Fstatfs(fd, &fs); err != nil {
		return "an unidentified filesystem"
	}
	if name, ok := filesystems[int64(fs.Type)]; ok {
		return name
	}
	return "filesystem 0x" + strconv.FormatInt(int64(fs.Type), 16)
}

// Open creates the reserved layout and proves openat2, RENAME_NOREPLACE and
// directory fsync on this root. There is no weaker fallback, so a filesystem
// without one of them refuses to start.
func Open(dir string) (*Disk, error) {
	fd, err := unix.Open(dir, unix.O_RDONLY|unix.O_DIRECTORY|unix.O_CLOEXEC, 0)
	if err != nil {
		return nil, fmt.Errorf("open storage root %s: %w", dir, err)
	}
	refuse := func(primitive string, err error) error {
		return fmt.Errorf("storage root %s on %s: %s failed: %w. storage-server needs it and has no fallback", dir, filesystemName(fd), primitive, err)
	}
	probe, err := openat2(fd, ".", unix.O_RDONLY|unix.O_DIRECTORY, 0)
	if err != nil {
		unix.Close(fd)
		return nil, refuse("openat2", err)
	}
	unix.Close(probe)

	files := &Tree{fd: fd, root: true}
	reserved := Path{ReservedDir}
	for _, p := range []Path{reserved, {ReservedDir + "/trash"}, {ReservedDir + "/spool"}} {
		if err := files.Mkdir(p); err != nil {
			unix.Close(fd)
			return nil, fmt.Errorf("create %s under %s: %w", p, dir, err)
		}
	}
	if err := probeRename(files, reserved); err != nil {
		unix.Close(fd)
		return nil, refuse(err.primitive, err.cause)
	}
	trash, err := files.Sub(Path{ReservedDir + "/trash"})
	if err != nil {
		unix.Close(fd)
		return nil, err
	}
	spool, err := files.Sub(Path{ReservedDir + "/spool"})
	if err != nil {
		trash.Close()
		unix.Close(fd)
		return nil, err
	}
	return &Disk{Files: files, Trash: trash, Spool: spool}, nil
}

type probeFailure struct {
	primitive string
	cause     error
}

// probeRename runs in a scratch directory on the real filesystem. It checks that
// a taken name is refused, not replaced, because a driver that ignores the flag
// would make every publish a silent overwrite.
func probeRename(files *Tree, reserved Path) *probeFailure {
	const scratch = ".probe"
	work := reserved.Join(Name{scratch})
	if err := files.RemoveAll(work); err != nil {
		return &probeFailure{"cleaning the startup probe", err}
	}
	if err := files.Mkdir(work); err != nil {
		return &probeFailure{"creating the startup probe", err}
	}
	defer files.RemoveAll(work)
	for _, name := range []string{"a", "b"} {
		if err := files.WriteDurable(work.Join(Name{name}), []byte(name)); err != nil {
			return &probeFailure{"writing the startup probe", err}
		}
	}
	dir, err := files.openDir(work)
	if err != nil {
		return &probeFailure{"opening the startup probe", err}
	}
	defer unix.Close(dir)

	switch err := unix.Renameat2(dir, "a", dir, "b", unix.RENAME_NOREPLACE); {
	case err == nil:
		return &probeFailure{"renameat2 RENAME_NOREPLACE", errors.New("it replaced an existing file")}
	case !errors.Is(err, unix.EEXIST):
		return &probeFailure{"renameat2 RENAME_NOREPLACE", err}
	}
	if err := unix.Renameat2(dir, "a", dir, "c", unix.RENAME_NOREPLACE); err != nil {
		return &probeFailure{"renameat2 RENAME_NOREPLACE", err}
	}
	if err := unix.Fsync(dir); err != nil {
		return &probeFailure{"directory fsync", err}
	}
	return nil
}

// Usage reports the root filesystem's capacity from fstatfs.
func (d *Disk) Usage() (total, free uint64, err error) {
	var fs unix.Statfs_t
	if err := unix.Fstatfs(d.Files.fd, &fs); err != nil {
		return 0, 0, err
	}
	return fs.Blocks * uint64(fs.Bsize), fs.Bavail * uint64(fs.Bsize), nil
}

func (d *Disk) Close() error {
	return errors.Join(d.Spool.Close(), d.Trash.Close(), d.Files.Close())
}
