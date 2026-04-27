import type { FileDropEvent } from 'file-drop-element';
import type SnackBarElement from 'shared/custom-els/snack-bar';
import type { SnackOptions } from 'shared/custom-els/snack-bar';

import { h, Component } from 'preact';

import { linkRef } from 'shared/prerendered-app/util';
import { isTauriRuntime } from 'shared/environment';
import * as style from './style.css';
import 'add-css:./style.css';
import 'file-drop-element';
import 'shared/custom-els/snack-bar';
import demoPhotoUrl from 'url:shared/prerendered-app/Intro/imgs/demos/demo-large-photo.jpg';
import 'shared/custom-els/loading-spinner';

const ROUTE_EDITOR = '/editor';
const ROUTE_BATCH = '/batch';
const SAMPLE_IMAGE_NAME = 'sample-photo.jpg';
const IMAGE_FILE_EXTENSIONS = new Set([
  '.jpg',
  '.jpeg',
  '.png',
  '.webp',
  '.gif',
  '.bmp',
  '.avif',
  '.jxl',
  '.svg',
  '.qoi',
  '.tif',
  '.tiff',
]);

const compressPromise = import('client/lazy-app/Compress');
const batchCompressPromise = import('client/lazy-app/BatchCompress');
const swBridgePromise = import('client/lazy-app/sw-bridge');

interface Props {}

interface BatchInputFile extends File {
  batchRelativePath?: string;
}

interface NativeFolderImage {
  name: string;
  relativePath: string;
  mime: string;
  bytes: number[];
}

interface State {
  awaitingShareTarget: boolean;
  file?: File;
  batchFiles?: File[];
  Compress?: typeof import('client/lazy-app/Compress').default;
  BatchCompress?: typeof import('client/lazy-app/BatchCompress').default;
}

export default class App extends Component<Props, State> {
  state: State = {
    awaitingShareTarget: new URL(location.href).searchParams.has(
      'share-target',
    ),
    file: undefined,
    batchFiles: undefined,
    Compress: undefined,
    BatchCompress: undefined,
  };

  snackbar?: SnackBarElement;
  fileInput?: HTMLInputElement;
  folderInput?: HTMLInputElement;

  constructor() {
    super();
    this.ensureEditorRoute({ replace: true });

    compressPromise
      .then((module) => {
        this.setState({ Compress: module.default });
      })
      .catch(() => {
        this.showSnack('应用加载失败');
      });

    batchCompressPromise
      .then((module) => {
        this.setState({ BatchCompress: module.default });
      })
      .catch(() => {
        this.showSnack('批量压缩模块加载失败');
      });

    swBridgePromise.then(async ({ offliner, getSharedImage }) => {
      offliner(this.showSnack);
      if (!this.state.awaitingShareTarget) return;
      const file = await getSharedImage();
      this.ensureEditorRoute({ replace: true });
      this.setState({
        file,
        batchFiles: undefined,
        awaitingShareTarget: false,
      });
    });

    // Since iOS 10, Apple tries to prevent disabling pinch-zoom. This is great in theory, but
    // really breaks things on Squoosh, as you can easily end up zooming the UI when you mean to
    // zoom the image. Once you've done this, it's really difficult to undo. Anyway, this seems to
    // prevent it.
    document.body.addEventListener('gesturestart', (event: any) => {
      event.preventDefault();
    });
  }

  private onFileDrop = ({ files }: FileDropEvent) => {
    if (!files || files.length === 0) return;
    const file = files[0];
    this.ensureEditorRoute();
    this.setState({ file, batchFiles: undefined });
  };

  private onFileInputChange = (event: Event) => {
    const input = event.currentTarget as HTMLInputElement;
    const file = input.files && input.files[0];
    if (!file) return;
    this.ensureEditorRoute();
    this.setState({ file, batchFiles: undefined });
    input.value = '';
  };

  private onFolderInputChange = (event: Event) => {
    const input = event.currentTarget as HTMLInputElement;
    const batchFiles = Array.from(input.files || []).filter(isImageFile);
    if (batchFiles.length === 0) {
      this.showSnack('该文件夹中没有支持的图片');
      input.value = '';
      return;
    }
    this.ensureBatchRoute();
    this.setState({ batchFiles, file: undefined });
    input.value = '';
  };

  private showSnack = (
    message: string,
    options: SnackOptions = {},
  ): Promise<string> => {
    if (!this.snackbar) throw Error('Snackbar missing');
    return this.snackbar.showSnackbar(message, options);
  };

  private ensureEditorRoute({ replace = false }: { replace?: boolean } = {}) {
    this.ensureRoute(ROUTE_EDITOR, { replace });
  }

  private ensureBatchRoute({ replace = false }: { replace?: boolean } = {}) {
    this.ensureRoute(ROUTE_BATCH, { replace });
  }

  private ensureRoute(
    pathname: string,
    { replace = false }: { replace?: boolean } = {},
  ) {
    if (location.pathname === pathname) return;
    const nextURL = new URL(location.href);
    nextURL.pathname = pathname;
    if (replace) {
      history.replaceState(null, '', nextURL.href);
    } else {
      history.pushState(null, '', nextURL.href);
    }
  }

  private onBack = () => {
    this.setState({ file: undefined, batchFiles: undefined });
    this.ensureEditorRoute({ replace: true });
  };

  private openFilePicker = () => {
    if (!this.fileInput) throw Error('File input missing');
    this.fileInput.click();
  };

  private openFolderPicker = () => {
    if (!isTauriRuntime) {
      if (!this.folderInput) throw Error('Folder input missing');
      this.folderInput.click();
      return;
    }

    this.pickFolder().catch((error) => {
      this.showSnack(error instanceof Error ? error.message : '打开文件夹失败');
    });
  };

  private async pickFolder() {
    if (isTauriRuntime) {
      const batchFiles = await this.pickNativeFolder();
      if (batchFiles.length === 0) return;
      this.ensureBatchRoute();
      this.setState({ batchFiles, file: undefined });
      return;
    }

    const directoryPicker = (window as any).showDirectoryPicker as
      | (() => Promise<any>)
      | undefined;

    if (directoryPicker) {
      try {
        const rootHandle = await directoryPicker();
        const batchFiles = await this.readImageFilesFromDirectory(rootHandle);
        if (batchFiles.length === 0) {
          await this.showSnack('该文件夹中没有支持的图片');
          return;
        }
        this.ensureBatchRoute();
        this.setState({ batchFiles, file: undefined });
        return;
      } catch (error) {
        if (!shouldFallbackToFolderInput(error)) {
          throw error;
        }
      }
    }

    if (!this.folderInput) throw Error('Folder input missing');
    this.folderInput.click();
  }

  private async pickNativeFolder() {
    const [{ open }, { invoke }] = await Promise.all([
      import('@tauri-apps/plugin-dialog'),
      import('@tauri-apps/api/core'),
    ]);
    const selected = await open({
      directory: true,
      multiple: false,
      title: '选择图片文件夹',
    });

    if (!selected || Array.isArray(selected)) return [];

    const entries = await invoke<NativeFolderImage[]>('read_image_folder', {
      folderPath: selected,
    });

    return entries.map((entry) => {
      const file = new File([new Uint8Array(entry.bytes)], entry.name, {
        type: entry.mime,
      }) as BatchInputFile;
      file.batchRelativePath = entry.relativePath;
      return file;
    });
  }

  private async readImageFilesFromDirectory(rootHandle: any) {
    const results: BatchInputFile[] = [];

    const walk = async (handle: any, relativePath: string) => {
      for await (const entry of handle.values()) {
        const nextPath = relativePath
          ? `${relativePath}/${entry.name}`
          : entry.name;

        if (entry.kind === 'directory') {
          await walk(entry, nextPath);
          continue;
        }

        if (entry.kind !== 'file') continue;
        const file = (await entry.getFile()) as BatchInputFile;
        if (!isImageFile(file)) continue;
        file.batchRelativePath = nextPath;
        results.push(file);
      }
    };

    await walk(rootHandle, '');
    return results;
  }

  private loadSampleImage = async () => {
    const response = await fetch(demoPhotoUrl);
    if (!response.ok) throw Error('示例图片加载失败');
    const blob = await response.blob();
    const sampleFile = new File([blob], SAMPLE_IMAGE_NAME, {
      type: blob.type || 'image/jpeg',
    });
    this.ensureEditorRoute();
    this.setState({ file: sampleFile, batchFiles: undefined });
  };

  render(
    {}: Props,
    { file, batchFiles, Compress, BatchCompress, awaitingShareTarget }: State,
  ) {
    const showSpinner = awaitingShareTarget || !Compress || !BatchCompress;

    return (
      <div class={style.app}>
        <file-drop onfiledrop={this.onFileDrop} class={style.drop}>
          {showSpinner ? (
            <loading-spinner class={style.appLoader} />
          ) : batchFiles && BatchCompress ? (
            <BatchCompress
              files={batchFiles}
              onBack={this.onBack}
              onPickFolder={this.openFolderPicker}
            />
          ) : (
            Compress && (
              <Compress
                file={file}
                showSnack={this.showSnack}
                onBack={this.onBack}
                onPickFile={this.openFilePicker}
                onPickFolder={this.openFolderPicker}
                onLoadSample={this.loadSampleImage}
              />
            )
          )}
          <input
            ref={linkRef(this, 'fileInput')}
            class={style.fileInput}
            type="file"
            accept="image/*"
            onChange={this.onFileInputChange}
          />
          <input
            ref={linkRef(this, 'folderInput')}
            class={style.fileInput}
            type="file"
            multiple
            onChange={this.onFolderInputChange}
            {...({ webkitdirectory: true, directory: true } as any)}
          />
          <snack-bar ref={linkRef(this, 'snackbar')} />
        </file-drop>
      </div>
    );
  }
}

function isImageFile(file: File) {
  if (file.type.startsWith('image/')) return true;
  const fileExtension = file.name
    .slice(file.name.lastIndexOf('.'))
    .toLowerCase();
  return IMAGE_FILE_EXTENSIONS.has(fileExtension);
}

function shouldFallbackToFolderInput(error: unknown) {
  return (
    error instanceof DOMException &&
    (error.name === 'AbortError' || error.name === 'SecurityError')
  );
}
