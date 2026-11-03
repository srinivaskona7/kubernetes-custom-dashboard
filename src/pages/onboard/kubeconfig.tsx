/**
 * The kubeconfig half of onboarding: holding the file, describing it on the server, and rendering
 * the two ways in. Both onboarding pages use it, which is the point — the rules about what a
 * kubeconfig *is* must not differ between the page that pairs it with a token and the page that
 * pairs it with a sign-in.
 *
 * **The YAML is parsed by the server, not here.** The hook posts the text to
 * `/clusters/kubeconfig/describe` and returns what comes back. A parser in the browser is a second
 * set of rules about CA decoding, context selection and https-only, and the two drift silently —
 * the version this replaced matched `name:` with a regex, so any `name:` in the file could become
 * the cluster's, and sliced the CA block at 3000 characters. The summary on screen is now, by
 * construction, the reading the server will act on.
 */
import { useCallback, useEffect, useRef, useState } from 'react';
import { api, ApiError, type KubeconfigDescription } from '../../api';
import { Btn } from '../../components/ui';
import { DESCRIBE_DEBOUNCE_MS, MAX_FILE_BYTES, type DirectCredentials, type SourceMode } from './shared';

export interface KubeconfigSource {
  mode: SourceMode;
  setMode: (m: SourceMode) => void;
  kubeconfig: string;
  setKubeconfig: (s: string) => void;
  /**
   * What the paste textarea calls on every keystroke.
   *
   * Not `clear()` followed by `setKubeconfig`: clear also drops the chosen context, so pasting or
   * editing YAML would reset a context the operator had picked on every character, and the
   * describe effect would keep re-adopting the file's default underneath them. This resets only
   * what a new paste actually invalidates — a previously loaded file and its descriptor.
   */
  setPasted: (s: string) => void;
  contextName: string;
  setContextName: (s: string) => void;
  fileName: string | null;
  fileSize: number | null;
  describing: boolean;
  described: KubeconfigDescription | null;
  describeError: ApiError | null;
  /** Set only when the file was the JSON descriptor rather than a kubeconfig. */
  direct: DirectCredentials | null;
  /** A token the *file* supplied, which the caller may adopt. Null when it carried none. */
  fileToken: string | null;
  /** A name suggested by the file, for a caller whose name field is still empty. */
  suggestedName: string | null;
  /** Non-null when the file itself is the problem — too large, or JSON with no apiUrl. */
  fileError: ApiError | null;
  handleFile: (f: File) => Promise<void>;
  clear: () => void;
  fileInputRef: React.MutableRefObject<HTMLInputElement | null>;
}

/**
 * @param acceptDescriptor false on a page where a JSON credentials descriptor makes no sense —
 *        the SSO page, which needs an identity provider and a descriptor names none.
 */
export function useKubeconfigSource({ acceptDescriptor = true }: { acceptDescriptor?: boolean } = {}): KubeconfigSource {
  const [mode, setMode] = useState<SourceMode>('upload');
  const [kubeconfig, setKubeconfig] = useState('');
  const [contextName, setContextName] = useState('');
  const [fileName, setFileName] = useState<string | null>(null);
  const [fileSize, setFileSize] = useState<number | null>(null);
  const [describing, setDescribing] = useState(false);
  const [described, setDescribed] = useState<KubeconfigDescription | null>(null);
  const [describeError, setDescribeError] = useState<ApiError | null>(null);
  const [direct, setDirect] = useState<DirectCredentials | null>(null);
  const [fileToken, setFileToken] = useState<string | null>(null);
  const [suggestedName, setSuggestedName] = useState<string | null>(null);
  const [fileError, setFileError] = useState<ApiError | null>(null);
  const fileInputRef = useRef<HTMLInputElement | null>(null);

  /**
   * Describe the kubeconfig whenever the text or the chosen context changes.
   *
   * `runId` is a generation counter, not a boolean: switching context fires a second describe
   * while the first is in flight, and without it the slower of the two wins and the panel
   * describes a context the operator is no longer looking at.
   */
  const runId = useRef(0);
  useEffect(() => {
    if (!kubeconfig.trim() || direct) {
      // Bump the generation and clear the flag here too, not only in the fetch's `finally`.
      // Clearing the textarea inside the debounce window cancels the timer, so that `finally`
      // never runs — leaving `describing` stuck true, which disables every credential button for
      // good. The bump also retires a describe still in flight, so a late answer for the old
      // kubeconfig cannot land on top of a JSON descriptor and show one API server on screen
      // while the submitted body carries another.
      ++runId.current;
      setDescribing(false);
      setDescribed(null);
      setDescribeError(null);
      return;
    }
    const mine = ++runId.current;
    setDescribing(true);
    const timer = setTimeout(() => {
      api.describeKubeconfig(kubeconfig, contextName || undefined)
        .then(answer => {
          if (runId.current !== mine) return;
          setDescribed(answer);
          setDescribeError(null);
          // Adopt the file's own context the first time, so the selector shows what is actually
          // being read rather than an empty "default".
          if (!contextName && answer.contextName) setContextName(answer.contextName);
        })
        .catch(err => {
          if (runId.current !== mine) return;
          setDescribed(null);
          setDescribeError(err instanceof ApiError ? err : new ApiError(String(err), 'UNKNOWN', 0));
        })
        .finally(() => { if (runId.current === mine) setDescribing(false); });
    }, DESCRIBE_DEBOUNCE_MS);
    return () => clearTimeout(timer);
  }, [kubeconfig, contextName, direct]);

  const loadText = useCallback((raw: string, nameHint: string) => {
    setFileError(null);
    setDescribeError(null);

    // A JSON descriptor is self-contained; a kubeconfig has to go to the server.
    try {
      const parsed = JSON.parse(raw) as Record<string, unknown>;
      const str = (k: string) => (typeof parsed[k] === 'string' ? (parsed[k] as string) : '');
      const apiUrl = str('apiUrl') || str('server');
      if (apiUrl) {
        if (!acceptDescriptor) {
          setFileError(new ApiError(
            'That is a JSON credentials descriptor. It names no identity provider, so there is nothing to sign in to — use the standard Add Cluster page, which pairs it with its token.',
            'NOT_A_KUBECONFIG', 0));
          return;
        }
        setDirect({ apiUrl: apiUrl.replace(/\/+$/, ''), caData: str('caData'), token: str('token'), name: str('name') });
        setKubeconfig('');
        setDescribed(null);
        setFileToken(str('token') || null);
        setSuggestedName(str('name') || nameHint);
        return;
      }
      setFileError(new ApiError(
        'That JSON has no `apiUrl`. Expected the file `npm run fleet:input` writes, or a kubeconfig.',
        'INVALID_FILE', 0));
      return;
    } catch {
      // Not JSON — treat it as kubeconfig YAML and let the server say whether it is.
    }

    setDirect(null);
    setFileToken(null);
    setContextName('');
    setKubeconfig(raw);
    setSuggestedName(nameHint);
  }, [acceptDescriptor]);

  const handleFile = useCallback(async (file: File) => {
    if (file.size > MAX_FILE_BYTES) {
      setFileError(new ApiError(
        `${file.name} is ${(file.size / 1024).toFixed(0)} KB; the limit is 512 KB. That is not a kubeconfig.`,
        'TOO_LARGE', 0));
      return;
    }
    setFileName(file.name);
    setFileSize(file.size);
    loadText(await file.text(), file.name.replace(/\.[^/.]+$/, '').replace(/^kubeconfig-+/, ''));
  }, [loadText]);

  /** A new paste invalidates a loaded file, but not the operator's context choice. */
  const setPasted = useCallback((text: string) => {
    setDirect(null);
    setFileName(null);
    setFileSize(null);
    setFileToken(null);
    setFileError(null);
    setKubeconfig(text);
  }, []);

  const clear = useCallback(() => {
    setKubeconfig('');
    setContextName('');
    setDirect(null);
    setDescribed(null);
    setDescribeError(null);
    setFileName(null);
    setFileSize(null);
    setFileToken(null);
    setSuggestedName(null);
    setFileError(null);
    if (fileInputRef.current) fileInputRef.current.value = '';
  }, []);

  return {
    mode, setMode, kubeconfig, setKubeconfig, setPasted, contextName, setContextName,
    fileName, fileSize, describing, described, describeError, direct,
    fileToken, suggestedName, fileError, handleFile, clear, fileInputRef
  };
}

/** The upload/paste toggle, for a `Step`'s `action` slot. */
export function SourceModeToggle({ src }: { src: KubeconfigSource }) {
  return (
    <div className="flex rounded-[6px] border border-line p-[2px]" role="group" aria-label="How to provide the kubeconfig">
      {(['upload', 'paste'] as const).map(m => (
        <button
          key={m}
          type="button"
          aria-pressed={src.mode === m}
          onClick={() => src.setMode(m)}
          className={`rounded-[4px] px-2.5 py-1 text-[13px] font-medium transition-colors ${
            src.mode === m ? 'bg-accent text-white' : 'text-muted hover:text-text'
          }`}
        >
          {m === 'upload' ? 'Upload file' : 'Paste YAML'}
        </button>
      ))}
    </div>
  );
}

/**
 * The file control itself: dropzone or textarea, the context selector once the server reports more
 * than one, and whatever went wrong reading it.
 *
 * @param dropHint what the dropzone says it wants. The two pages accept different files, and a
 *        dropzone that offers a `.json` descriptor on the page that cannot use one is a dead end
 *        dressed as an option.
 */
export function KubeconfigField({
  src,
  idPrefix,
  dropHint
}: {
  src: KubeconfigSource;
  idPrefix: string;
  dropHint: React.ReactNode;
}) {
  return (
    <>
      {src.mode === 'upload' ? (
        src.fileName ? (
          <div className="flex items-center justify-between gap-3 rounded-[6px] border border-line bg-raised px-3.5 py-2.5">
            <div className="min-w-0">
              <div className="truncate text-[14px] font-medium text-text">{src.fileName}</div>
              <div className="mono text-[12px] text-muted">
                {src.fileSize !== null ? `${(src.fileSize / 1024).toFixed(1)} KB` : ''}
                {src.direct ? ' · JSON credentials descriptor' : ' · kubeconfig'}
              </div>
            </div>
            <Btn onClick={src.clear}>Change</Btn>
          </div>
        ) : (
          <div
            onDragOver={e => e.preventDefault()}
            onDrop={e => { e.preventDefault(); const f = e.dataTransfer.files?.[0]; if (f) void src.handleFile(f); }}
            onClick={() => src.fileInputRef.current?.click()}
            onKeyDown={e => { if (e.key === 'Enter' || e.key === ' ') { e.preventDefault(); src.fileInputRef.current?.click(); } }}
            role="button"
            tabIndex={0}
            className="cursor-pointer rounded-[6px] border border-dashed border-line bg-raised/40 px-4 py-7 text-center transition-colors hover:border-accent focus:border-accent focus:outline-none"
          >
            <div className="text-[14px] font-medium text-text">Drop a kubeconfig here, or click to browse</div>
            <div className="mt-1 text-[12px] text-muted">{dropHint}</div>
            <input
              ref={src.fileInputRef}
              type="file"
              accept=".json,.yaml,.yml,application/json,text/yaml"
              onChange={e => { const f = e.target.files?.[0]; if (f) void src.handleFile(f); }}
              className="hidden"
            />
          </div>
        )
      ) : (
        <>
          <label htmlFor={`${idPrefix}-paste`} className="sr-only">Kubeconfig YAML</label>
          <textarea
            id={`${idPrefix}-paste`}
            value={src.kubeconfig}
            onChange={e => src.setPasted(e.target.value)}
            rows={10}
            spellCheck={false}
            placeholder={'apiVersion: v1\nkind: Config\nclusters:\n  - name: …\n    cluster:\n      server: https://api.…\n      certificate-authority-data: …'}
            className="w-full resize-y rounded-[6px] border border-line bg-raised p-3 font-mono text-[12px] leading-[1.5] text-text placeholder:text-muted focus:border-accent focus:outline-none"
          />
          {src.kubeconfig.trim() !== '' && (
            <button type="button" onClick={src.clear} className="mt-2 text-[12px] font-medium text-muted hover:text-text">
              Clear
            </button>
          )}
        </>
      )}

      {src.described && src.described.contexts.length > 1 && (
        <div className="mt-3 flex items-center gap-2.5">
          <label htmlFor={`${idPrefix}-context`} className="text-[12px] font-semibold uppercase tracking-[0.06em] text-muted">
            Context
          </label>
          <select
            id={`${idPrefix}-context`}
            value={src.contextName}
            onChange={e => src.setContextName(e.target.value)}
            className="mono h-8 min-w-0 flex-1 rounded-[6px] border border-line bg-raised px-2 text-[13px] text-text focus:border-accent focus:outline-none"
          >
            {src.described.contexts.map(c => <option key={c} value={c}>{c}</option>)}
          </select>
        </div>
      )}

      {(src.describeError || src.fileError) && (
        <p className="mt-3 rounded-[6px] border border-bad/40 bg-bad/10 p-2.5 text-[13px] text-bad">
          <span className="mono font-semibold">{(src.describeError || src.fileError)!.code}</span>
          {' — '}
          {(src.describeError || src.fileError)!.message}
        </p>
      )}
    </>
  );
}
