/* Google sign-in and Drive file access for the Open Books reader.
 *
 * Uses the Google Identity Services *token* flow, which is the right fit for a
 * static site: it needs only the public client ID, never the client secret.
 *
 * Why this exists at all: Drive's /preview iframe authenticates with the
 * browser's Google cookies, and Safari and Firefox partition or block cookies
 * in third-party frames. Fetching the file through the Drive API with a bearer
 * token sidesteps cookies completely, so a restricted book opens in any
 * browser once its reader is signed in.
 */
(function () {
  "use strict";

  const CONFIG = window.OPEN_BOOKS_CONFIG || {};
  const CLIENT_ID = String(CONFIG.googleClientId || "").trim();
  const SCOPES = [
    "openid",
    "email",
    "profile",
    "https://www.googleapis.com/auth/drive.readonly"
  ].join(" ");
  const GIS_SRC = "https://accounts.google.com/gsi/client";
  const DRIVE_API = "https://www.googleapis.com/drive/v3";
  const USERINFO_API = "https://www.googleapis.com/oauth2/v3/userinfo";
  const RETURNING_KEY = "obl:google-returning";
  const GIS_TIMEOUT_MS = 15000;

  // The access token stays in memory only. It is a bearer credential, so it is
  // never written to storage; a returning visitor is re-authorised silently
  // instead (see restore()).
  let token = null; // { value, expiresAt }
  let user = null; // { email, name }
  let tokenClient = null;
  let gisPromise = null;
  let pending = null;
  const listeners = [];

  function isConfigured() {
    return CLIENT_ID !== "";
  }

  function isSignedIn() {
    return Boolean(token && token.expiresAt > Date.now());
  }

  function getUser() {
    return user;
  }

  function onChange(listener) {
    listeners.push(listener);
  }

  function emit() {
    listeners.forEach((listener) => {
      try {
        listener();
      } catch (e) { /* a bad listener must not break auth */ }
    });
  }

  function wasSignedIn() {
    try {
      return localStorage.getItem(RETURNING_KEY) === "1";
    } catch (e) {
      return false;
    }
  }

  function rememberSignedIn(value) {
    try {
      if (value) localStorage.setItem(RETURNING_KEY, "1");
      else localStorage.removeItem(RETURNING_KEY);
    } catch (e) { /* storage unavailable */ }
  }

  function failure(code, message) {
    const error = new Error(message);
    error.code = code;
    return error;
  }

  function loadGis() {
    if (gisPromise) return gisPromise;
    gisPromise = new Promise((resolve, reject) => {
      if (window.google && window.google.accounts && window.google.accounts.oauth2) {
        resolve();
        return;
      }
      const script = document.createElement("script");
      script.src = GIS_SRC;
      script.async = true;
      script.defer = true;

      // A blocked request can stall without ever firing `error`, which would
      // leave the caller waiting forever, so the wait is bounded.
      const timer = setTimeout(() => {
        gisPromise = null; // let a later attempt retry from scratch
        reject(failure("network", "Google sign-in did not load in time. A script blocker or network filter may be blocking accounts.google.com."));
      }, GIS_TIMEOUT_MS);

      script.onload = () => {
        clearTimeout(timer);
        resolve();
      };
      script.onerror = () => {
        clearTimeout(timer);
        gisPromise = null;
        reject(failure("network", "Google sign-in could not load. Check your connection or any script blocker."));
      };
      document.head.appendChild(script);
    });
    return gisPromise;
  }

  // Google reports an unlisted origin only through this generic code, so the
  // message names the likely cause rather than echoing an opaque string.
  function describe(response) {
    const code = String((response && (response.type || response.error)) || "");
    if (/popup_closed|popup_failed_to_open|user_cancel|access_denied/i.test(code)) {
      return failure("cancelled", "Sign-in was cancelled.");
    }
    if (/idpiframe|origin|invalid_client|unauthorized/i.test(code)) {
      return failure(
        "origin",
        `This site's address (${location.origin}) is not listed under the Google client's ` +
        "Authorized JavaScript origins, so Google refused the sign-in."
      );
    }
    return failure("auth", `Google sign-in failed (${code || "unknown error"}).`);
  }

  async function requestToken(mode) {
    await loadGis();
    if (!tokenClient) {
      tokenClient = window.google.accounts.oauth2.initTokenClient({
        client_id: CLIENT_ID,
        scope: SCOPES,
        callback: () => {}
      });
    }
    if (pending) return pending;

    pending = new Promise((resolve, reject) => {
      tokenClient.callback = (response) => {
        pending = null;
        if (!response || response.error || !response.access_token) {
          reject(describe(response));
          return;
        }
        const ttl = Number(response.expires_in || 3600);
        token = {
          value: response.access_token,
          // Expire a minute early so a request never starts on a dead token.
          expiresAt: Date.now() + Math.max(60, ttl - 60) * 1000
        };
        rememberSignedIn(true);
        resolve(token.value);
      };
      tokenClient.error_callback = (error) => {
        pending = null;
        reject(describe(error));
      };
      try {
        // "" lets Google skip the chooser when a grant already exists;
        // "select_account" is used when the reader asks to switch accounts.
        tokenClient.requestAccessToken({ prompt: mode === "switch" ? "select_account" : "" });
      } catch (error) {
        pending = null;
        reject(describe(error));
      }
    });
    return pending;
  }

  async function loadUser() {
    if (!isSignedIn()) return null;
    try {
      const response = await fetch(USERINFO_API, {
        headers: { Authorization: `Bearer ${token.value}` }
      });
      if (!response.ok) return null;
      const profile = await response.json();
      user = { email: profile.email || "", name: profile.name || "" };
      return user;
    } catch (error) {
      return null; // identity is a nicety; Drive access does not depend on it
    }
  }

  async function signIn(mode) {
    await requestToken(mode);
    await loadUser();
    emit();
    return user;
  }

  function signOut() {
    const value = token && token.value;
    token = null;
    user = null;
    rememberSignedIn(false);
    if (value && window.google && window.google.accounts && window.google.accounts.oauth2) {
      try {
        window.google.accounts.oauth2.revoke(value, () => {});
      } catch (e) { /* revocation is best effort */ }
    }
    emit();
  }

  // Silent re-authorisation for someone who signed in before. It only succeeds
  // where the browser still lets Google see its own session, so failure here is
  // ordinary and simply leaves the sign-in button showing.
  async function restore() {
    if (!isConfigured() || !wasSignedIn() || isSignedIn()) return false;
    try {
      await requestToken("silent");
      await loadUser();
      emit();
      return true;
    } catch (error) {
      return false;
    }
  }

  async function ensureToken() {
    if (isSignedIn()) return token.value;
    if (!wasSignedIn()) throw failure("signedout", "Sign in with Google to open this file.");
    return requestToken("silent"); // expired mid-session; renew without a prompt
  }

  async function driveFetch(path, params) {
    const accessToken = await ensureToken();
    const url = new URL(`${DRIVE_API}/${path}`);
    Object.keys(params || {}).forEach((key) => url.searchParams.set(key, params[key]));
    return fetch(url.toString(), { headers: { Authorization: `Bearer ${accessToken}` } });
  }

  function accessError(status) {
    if (status === 401) {
      token = null;
      return failure("signedout", "Your Google session expired. Sign in again to continue.");
    }
    if (status === 403) {
      return failure("forbidden", "This Google account does not have permission to open this file.");
    }
    if (status === 404) {
      return failure("notfound", "This file is not shared with this account, or it no longer exists.");
    }
    return failure("http", `Google Drive returned an error (HTTP ${status}).`);
  }

  // Drive is the authority on access — the static audit in resource-meta.json
  // only ever knew what an anonymous visitor could see.
  async function fileMeta(fileId) {
    const response = await driveFetch(`files/${encodeURIComponent(fileId)}`, {
      fields: "id,name,mimeType,size,capabilities(canDownload)",
      supportsAllDrives: "true"
    });
    if (!response.ok) throw accessError(response.status);
    const meta = await response.json();
    return {
      id: meta.id,
      name: meta.name || "",
      mimeType: meta.mimeType || "",
      size: Number(meta.size || 0),
      canDownload: !meta.capabilities || meta.capabilities.canDownload !== false
    };
  }

  // Returns a blob: URL the reader can hand straight to an <iframe>, which
  // keeps the document inside our own origin rather than a Google frame.
  async function fileBlobUrl(fileId, onProgress) {
    const accessToken = await ensureToken();
    const url = `${DRIVE_API}/files/${encodeURIComponent(fileId)}?alt=media&supportsAllDrives=true`;
    const response = await fetch(url, { headers: { Authorization: `Bearer ${accessToken}` } });
    if (!response.ok) throw accessError(response.status);

    const total = Number(response.headers.get("content-length") || 0);
    if (!response.body || !response.body.getReader) {
      const blob = await response.blob();
      return URL.createObjectURL(blob.type ? blob : new Blob([blob], { type: "application/pdf" }));
    }

    const reader = response.body.getReader();
    const chunks = [];
    let received = 0;
    for (;;) {
      const step = await reader.read();
      if (step.done) break;
      chunks.push(step.value);
      received += step.value.length;
      if (onProgress) onProgress(received, total);
    }
    return URL.createObjectURL(new Blob(chunks, { type: "application/pdf" }));
  }

  window.OpenBooksDrive = {
    isConfigured,
    isSignedIn,
    wasSignedIn,
    getUser,
    onChange,
    signIn,
    signOut,
    restore,
    fileMeta,
    fileBlobUrl
  };
})();
