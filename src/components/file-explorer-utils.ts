export type FileCollection = { [path: string]: string };

export function hasFile(
  files: FileCollection,
  filePath: string | null | undefined
): filePath is string {
  return (
    typeof filePath === "string" &&
    Object.prototype.hasOwnProperty.call(files, filePath) &&
    typeof files[filePath] === "string"
  );
}

export function getInitialSelectedFile(files: FileCollection): string | null {
  const fileKeys = Object.keys(files);
  return fileKeys.length > 0 ? fileKeys[0] : null;
}

export function getFileContent(
  files: FileCollection,
  filePath: string | null | undefined
): string | null {
  if (!hasFile(files, filePath)) {
    return null;
  }
  return files[filePath];
}
