import { h, Component } from 'preact';
import { zip } from 'fflate';

import { isTauriRuntime } from 'shared/environment';
import * as style from './style.css';
import 'add-css:./style.css';
import WorkerBridge from '../worker-bridge';
import { encoderMap, EncoderState } from '../feature-meta';
import {
  BatchResizeOptions,
  decodeFileToImageData,
  encodeImageData,
  resizeImageDataForBatch,
} from '../compress-pipeline';
import prettyBytes from '../Compress/Results/pretty-bytes';

type SupportedEncoderMap = Partial<typeof encoderMap>;
type BatchInputFile = File & {
  webkitRelativePath?: string;
  batchRelativePath?: string;
};

interface Props {
  files: File[];
  onBack: () => void;
  onPickFolder: () => void;
}

interface BatchResult {
  path: string;
  inputSize: number;
  outputSize?: number;
  status: 'pending' | 'processing' | 'done' | 'error';
  error?: string;
}

interface State {
  supportedEncoderMap?: SupportedEncoderMap;
  encoderState: EncoderState;
  processing: boolean;
  completed: number;
  currentFile?: string;
  zipUrl?: string;
  zipName?: string;
  savedPath?: string;
  saveError?: string;
  resizeOptions: BatchResizeOptions;
  results: BatchResult[];
}

const supportedEncoderMapP: Promise<SupportedEncoderMap> = (async () => {
  const supportedEncoderMap: SupportedEncoderMap = { ...encoderMap };
  await Promise.all(
    Object.entries(encoderMap).map(async ([encoderName, details]) => {
      if ('featureTest' in details && !(await details.featureTest())) {
        delete supportedEncoderMap[encoderName as keyof typeof encoderMap];
      }
    }),
  );
  return supportedEncoderMap;
})();

function relativePath(file: File): string {
  return (
    (file as BatchInputFile).batchRelativePath ||
    (file as BatchInputFile).webkitRelativePath ||
    file.name
  );
}

function outputPath(inputPath: string, encoderState: EncoderState): string {
  const extension = encoderMap[encoderState.type].meta.extension;
  return inputPath.replace(/.[^.]*$/, `.${extension}`);
}

function defaultResults(files: File[]): BatchResult[] {
  return files.map((file) => ({
    path: relativePath(file),
    inputSize: file.size,
    status: 'pending',
  }));
}

export default class BatchCompress extends Component<Props, State> {
  private readonly workerBridge = new WorkerBridge();
  private abortController = new AbortController();
  private zipBuffer?: Uint8Array;

  constructor(props: Props) {
    super(props);
    this.state = {
      supportedEncoderMap: undefined,
      encoderState: {
        type: 'mozJPEG',
        options: encoderMap.mozJPEG.meta.defaultOptions,
      },
      processing: false,
      completed: 0,
      currentFile: undefined,
      zipUrl: undefined,
      zipName: undefined,
      savedPath: undefined,
      saveError: undefined,
      resizeOptions: {
        enabled: false,
        maxWidth: 1080,
        maxHeight: undefined,
      },
      results: defaultResults(props.files),
    };

    supportedEncoderMapP.then((supportedEncoderMap) =>
      this.setState({ supportedEncoderMap }),
    );
  }

  componentWillReceiveProps(nextProps: Props): void {
    if (nextProps.files !== this.props.files) {
      if (this.state.zipUrl) URL.revokeObjectURL(this.state.zipUrl);
      this.zipBuffer = undefined;
      this.setState({
        processing: false,
        completed: 0,
        currentFile: undefined,
        zipUrl: undefined,
        zipName: undefined,
        savedPath: undefined,
        saveError: undefined,
        results: defaultResults(nextProps.files),
      });
    }
  }

  componentWillUnmount(): void {
    this.abortController.abort();
    if (this.state.zipUrl) URL.revokeObjectURL(this.state.zipUrl);
  }

  private onEncoderTypeChange = (event: Event) => {
    const type = (event.currentTarget as HTMLSelectElement)
      .value as keyof typeof encoderMap;
    if (this.state.zipUrl) URL.revokeObjectURL(this.state.zipUrl);
    this.zipBuffer = undefined;
    this.setState({
      encoderState: {
        type,
        options: encoderMap[type].meta.defaultOptions as any,
      },
      zipUrl: undefined,
      zipName: undefined,
      savedPath: undefined,
      saveError: undefined,
      completed: 0,
      currentFile: undefined,
      results: defaultResults(this.props.files),
    });
  };

  private onEncoderOptionsChange = (options: unknown) => {
    if (this.state.zipUrl) URL.revokeObjectURL(this.state.zipUrl);
    this.zipBuffer = undefined;
    this.setState({
      encoderState: {
        ...this.state.encoderState,
        options: options as any,
      },
      zipUrl: undefined,
      zipName: undefined,
      savedPath: undefined,
      saveError: undefined,
    });
  };

  private onResizeEnabledChange = (event: Event) => {
    const enabled = (event.currentTarget as HTMLInputElement).checked;
    this.zipBuffer = undefined;
    if (this.state.zipUrl) URL.revokeObjectURL(this.state.zipUrl);
    this.setState({
      resizeOptions: {
        ...this.state.resizeOptions,
        enabled,
      },
      zipUrl: undefined,
      zipName: undefined,
      savedPath: undefined,
      saveError: undefined,
      completed: 0,
      currentFile: undefined,
      results: defaultResults(this.props.files),
    });
  };

  private onResizeNumberChange =
    (field: 'maxWidth' | 'maxHeight') => (event: Event) => {
      const value = Number((event.currentTarget as HTMLInputElement).value);
      this.zipBuffer = undefined;
      if (this.state.zipUrl) URL.revokeObjectURL(this.state.zipUrl);
      this.setState({
        resizeOptions: {
          ...this.state.resizeOptions,
          [field]: Number.isFinite(value) && value > 0 ? value : undefined,
        },
        zipUrl: undefined,
        zipName: undefined,
        savedPath: undefined,
        saveError: undefined,
        completed: 0,
        currentFile: undefined,
        results: defaultResults(this.props.files),
      });
    };

  private createZip(entries: Record<string, Uint8Array>): Promise<Uint8Array> {
    return new Promise((resolve, reject) => {
      zip(entries, (err, data) => {
        if (err) {
          reject(err);
          return;
        }
        resolve(data);
      });
    });
  }

  private startBatch = async () => {
    if (this.state.processing) return;
    if (this.state.zipUrl) URL.revokeObjectURL(this.state.zipUrl);
    this.zipBuffer = undefined;

    this.abortController.abort();
    this.abortController = new AbortController();
    const signal = this.abortController.signal;
    const zipEntries: Record<string, Uint8Array> = {};

    this.setState({
      processing: true,
      completed: 0,
      currentFile: undefined,
      zipUrl: undefined,
      zipName: undefined,
      savedPath: undefined,
      saveError: undefined,
      results: defaultResults(this.props.files),
    });

    let completed = 0;

    for (const file of this.props.files) {
      const path = relativePath(file);

      this.setState((currentState) => ({
        currentFile: path,
        results: currentState.results.map((result) =>
          result.path === path
            ? { ...result, status: 'processing', error: undefined }
            : result,
        ),
      }));

      try {
        const decoded = await decodeFileToImageData(
          signal,
          file,
          this.workerBridge,
        );
        const processed = await resizeImageDataForBatch(
          signal,
          decoded,
          file,
          this.state.resizeOptions,
          this.workerBridge,
        );
        const compressed = await encodeImageData(
          signal,
          processed,
          this.state.encoderState,
          file.name,
          this.workerBridge,
        );

        zipEntries[outputPath(path, this.state.encoderState)] = new Uint8Array(
          await compressed.arrayBuffer(),
        );
        completed += 1;

        this.setState((currentState) => ({
          completed,
          results: currentState.results.map((result) =>
            result.path === path
              ? {
                  ...result,
                  status: 'done',
                  outputSize: compressed.size,
                }
              : result,
          ),
        }));
      } catch (err) {
        if (err instanceof Error && err.name === 'AbortError') return;

        this.setState((currentState) => ({
          results: currentState.results.map((result) =>
            result.path === path
              ? {
                  ...result,
                  status: 'error',
                  error: err instanceof Error ? err.message : String(err),
                }
              : result,
          ),
        }));
      }
    }

    const zipBuffer = await this.createZip(zipEntries);
    this.zipBuffer = zipBuffer;
    const zipBlob = new Blob([zipBuffer], { type: 'application/zip' });
    const zipUrl = URL.createObjectURL(zipBlob);

    this.setState({
      processing: false,
      currentFile: undefined,
      zipUrl,
      zipName: `量子图片处理-批量-${Date.now()}.zip`,
    });
  };

  private saveZip = async () => {
    const { zipName } = this.state;
    if (!zipName || !this.zipBuffer) return;

    if (!isTauriRuntime) {
      if (!this.state.zipUrl) return;
      const link = document.createElement('a');
      link.href = this.state.zipUrl;
      link.download = zipName;
      link.click();
      return;
    }

    try {
      const [{ save }, { invoke }] = await Promise.all([
        import('@tauri-apps/plugin-dialog'),
        import('@tauri-apps/api/core'),
      ]);
      const zipPath = await save({
        title: '保存压缩后的图片',
        defaultPath: zipName,
        filters: [{ name: 'ZIP 压缩包', extensions: ['zip'] }],
      });

      if (!zipPath) return;

      await invoke('write_zip_file', {
        zipPath,
        bytes: Array.from(this.zipBuffer),
      });
      this.setState({ savedPath: zipPath, saveError: undefined });
    } catch (error) {
      this.setState({
        savedPath: undefined,
        saveError: error instanceof Error ? error.message : String(error),
      });
    }
  };

  render({ files, onBack, onPickFolder }: Props, state: State) {
    const {
      supportedEncoderMap,
      encoderState,
      processing,
      completed,
      currentFile,
    } = state;
    const encoder = encoderMap[encoderState.type];
    const EncoderOptionsComponent =
      encoder && 'Options' in encoder ? encoder.Options : undefined;
    const totalInput = files.reduce((sum, file) => sum + file.size, 0);
    const totalOutput = state.results.reduce(
      (sum, result) => sum + (result.outputSize || 0),
      0,
    );
    const inputPretty = prettyBytes(totalInput);
    const outputPretty = totalOutput ? prettyBytes(totalOutput) : undefined;
    const progress = files.length
      ? Math.round((completed / files.length) * 100)
      : 0;

    return (
      <div class={style.batch}>
        <button class={style.back} onClick={onBack}>
          X
        </button>

        <div class={style.main}>
          <div class={style.hero}>
            <div class={style.eyebrow}>批量压缩</div>
            <h1 class={style.title}>一次处理整个图片文件夹。</h1>
            <p class={style.text}>
              当前批量任务包含 {files.length}{' '}
              张图片。所有图片会使用同一套调整尺寸和压缩设置，并导出为 ZIP
              文件。
            </p>
          </div>

          <div class={style.summary}>
            <div class={style.metricCard}>
              <div class={style.metricLabel}>图片数量</div>
              <div class={style.metricValue}>{files.length}</div>
            </div>
            <div class={style.metricCard}>
              <div class={style.metricLabel}>原始大小</div>
              <div class={style.metricValue}>
                {inputPretty.value} {inputPretty.unit}
              </div>
            </div>
            <div class={style.metricCard}>
              <div class={style.metricLabel}>输出大小</div>
              <div class={style.metricValue}>
                {outputPretty
                  ? `${outputPretty.value} ${outputPretty.unit}`
                  : '--'}
              </div>
            </div>
          </div>

          <div class={style.progressBlock}>
            <div class={style.progressLabel}>
              <span>
                {processing && currentFile ? `正在处理 ${currentFile}` : '进度'}
              </span>
              <span>
                {completed} / {files.length}
              </span>
            </div>
            <div class={style.progressBar}>
              <div
                class={style.progressFill}
                style={{ width: `${progress}%` }}
              />
            </div>
          </div>

          <div class={style.fileList}>
            {state.results.map((result) => {
              const inputFileSize = prettyBytes(result.inputSize);
              const outputFileSize =
                result.outputSize !== undefined
                  ? prettyBytes(result.outputSize)
                  : undefined;

              return (
                <div class={style.fileRow} key={result.path}>
                  <div class={style.filePath}>{result.path}</div>
                  <div class={style.fileMeta}>
                    {inputFileSize.value} {inputFileSize.unit}
                  </div>
                  <div class={style.fileStatus}>
                    {result.status === 'error' && result.error
                      ? result.error
                      : result.status === 'done' && outputFileSize
                      ? `${outputFileSize.value} ${outputFileSize.unit}`
                      : result.status}
                  </div>
                </div>
              );
            })}
          </div>
        </div>

        <div class={style.sidebar}>
          <div class={style.panelSection}>
            <h2 class={style.panelHeading}>压缩格式</h2>
            <select
              class={style.select}
              value={encoderState.type}
              onChange={this.onEncoderTypeChange}
            >
              {supportedEncoderMap &&
                Object.entries(supportedEncoderMap).map(([type, details]) => (
                  <option value={type}>{details.meta.label}</option>
                ))}
            </select>
            <div class={style.hint}>
              文件夹中的所有图片都会使用这个输出格式。
            </div>
          </div>

          <div class={style.panelSection}>
            <label class={style.toggleRow}>
              <span>调整尺寸</span>
              <input
                type="checkbox"
                checked={state.resizeOptions.enabled}
                onChange={this.onResizeEnabledChange}
              />
            </label>
            {state.resizeOptions.enabled && (
              <div class={style.resizeFields}>
                <label>
                  最大宽度
                  <input
                    type="number"
                    min="1"
                    value={state.resizeOptions.maxWidth || ''}
                    onInput={this.onResizeNumberChange('maxWidth')}
                  />
                </label>
                <label>
                  最大高度
                  <input
                    type="number"
                    min="1"
                    placeholder="不限制"
                    value={state.resizeOptions.maxHeight || ''}
                    onInput={this.onResizeNumberChange('maxHeight')}
                  />
                </label>
                <div class={style.hint}>
                  图片会按比例缩小到限制范围内，不会放大小图。
                </div>
              </div>
            )}
          </div>

          {EncoderOptionsComponent && (
            <div class={style.panelSection}>
              <h2 class={style.panelHeading}>压缩设置</h2>
              <EncoderOptionsComponent
                options={encoderState.options as any}
                onChange={this.onEncoderOptionsChange}
              />
            </div>
          )}

          <div class={style.actions}>
            <button
              class={style.actionPrimary}
              onClick={this.startBatch}
              disabled={processing}
            >
              {processing ? '正在压缩...' : '开始批量压缩'}
            </button>
            <button class={style.actionSecondary} onClick={onPickFolder}>
              选择其他文件夹
            </button>
            {state.zipName && (
              <button
                class={style.download}
                onClick={this.saveZip}
                disabled={!this.zipBuffer}
              >
                保存 ZIP 到磁盘
              </button>
            )}
            {(state.savedPath || state.saveError) && (
              <div class={style.saveStatus}>
                {state.savedPath
                  ? `已保存到 ${state.savedPath}`
                  : state.saveError}
              </div>
            )}
          </div>
        </div>
      </div>
    );
  }
}
