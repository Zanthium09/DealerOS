// Files go to the API as base64 inside JSON — no multipart, same transport as the dealer
// importer. Kept in one place now that more than one page uploads.
export function fileToBase64(file: File): Promise<string> {
  return new Promise((resolve, reject) => {
    const reader = new FileReader();
    reader.onload = () => resolve((reader.result as string).split(',')[1] ?? '');
    reader.onerror = reject;
    reader.readAsDataURL(file);
  });
}
