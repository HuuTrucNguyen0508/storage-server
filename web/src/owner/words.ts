import { ApiError } from "../api";

const WORDS: Record<string, string> = {
  exists: "That name is taken here",
  cross_device: "That move crosses a mounted disk, which the server refuses",
  move_into_self: "A folder can't move into itself",
  not_a_directory: "The destination is not a folder",
  symlink_refused: "A symlink is on that path, which the server refuses",
  reserved_name: "That name is reserved by the server",
  invalid_path: "That name can't be used",
  not_found: "That item is gone",
  not_shareable: "Symlinks can't be shared",
  drop_needs_folder: "Only a folder can take a drop link",
  weak_password: "Use at least 8 characters",
  bad_credentials: "That password is not right",
  bad_code: "That setup code is not right",
  already_set_up: "This server is already set up",
};

export function wordsFor(code: string): string {
  return WORDS[code] ?? "Something went wrong on the server";
}

export function errorText(err: unknown): string {
  if (!(err instanceof ApiError)) return "The server could not be reached";
  if (err.code === "rate_limited") {
    return err.retryAfter === null ? "Too many tries. Wait a moment." : `Too many tries. Try again in ${err.retryAfter} seconds.`;
  }
  return wordsFor(err.code);
}
