// Leave blank when PDFs are stored beside this app.
// To host chapter PDFs in a separate public repository, set this to that
// repository's GitHub Pages base URL, without a trailing slash.
window.OPEN_BOOKS_CONFIG = {
  pdfBaseUrl: "",

  // Google OAuth *client ID*, used to read Drive files that are shared with
  // specific accounts. This value is public by design — it ships inside the
  // page, and Google enforces access by matching the requesting origin
  // against the client's "Authorized JavaScript origins" list.
  //
  // Never put the matching client *secret* here. The browser flow does not
  // use it and this repository is public.
  //
  // Set to "" to turn Google sign-in off and fall back to Drive's own
  // cookie-based preview.
  googleClientId: "122427222536-94356im0a1ne6jlc29nem3487q5k0js9.apps.googleusercontent.com"
};
