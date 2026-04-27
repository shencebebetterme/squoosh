import {
  abortable,
  assertSignal,
  blobToImg,
  blobToText,
  builtinDecode,
  canDecodeImageType,
  sniffMimeType,
  ImageMimeTypes,
} from './util';
import WorkerBridge from './worker-bridge';
import { encoderMap, EncoderState } from './feature-meta';
import { drawableToImageData } from './util/canvas';
import { resize } from 'features/processors/resize/client';

export async function decodeImageBlob(
  signal: AbortSignal,
  blob: Blob,
  workerBridge: WorkerBridge,
): Promise<ImageData> {
  assertSignal(signal);
  const mimeType = await abortable(signal, sniffMimeType(blob));
  const canDecode = await abortable(signal, canDecodeImageType(mimeType));

  try {
    if (!canDecode) {
      if (mimeType === 'image/avif')
        return await workerBridge.avifDecode(signal, blob);
      if (mimeType === 'image/webp')
        return await workerBridge.webpDecode(signal, blob);
      if (mimeType === 'image/jxl')
        return await workerBridge.jxlDecode(signal, blob);
      if (mimeType === 'image/webp2')
        return await workerBridge.wp2Decode(signal, blob);
      if (mimeType === 'image/qoi')
        return await workerBridge.qoiDecode(signal, blob);
    }

    return await builtinDecode(signal, blob);
  } catch (err) {
    if (err instanceof Error && err.name === 'AbortError') throw err;
    throw Error("Couldn't decode image");
  }
}

async function processSvg(
  signal: AbortSignal,
  blob: Blob,
): Promise<HTMLImageElement> {
  assertSignal(signal);
  const parser = new DOMParser();
  const text = await abortable(signal, blobToText(blob));
  const document = parser.parseFromString(text, 'image/svg+xml');
  const svg = document.documentElement!;

  if (svg.hasAttribute('width') && svg.hasAttribute('height')) {
    return blobToImg(blob);
  }

  const viewBox = svg.getAttribute('viewBox');
  if (viewBox === null) throw Error('SVG must have width/height or viewBox');

  const viewboxParts = viewBox.split(/\s+/);
  svg.setAttribute('width', viewboxParts[2]);
  svg.setAttribute('height', viewboxParts[3]);

  const serializer = new XMLSerializer();
  const newSource = serializer.serializeToString(document);
  return abortable(
    signal,
    blobToImg(new Blob([newSource], { type: 'image/svg+xml' })),
  );
}

export async function decodeFileToImageData(
  signal: AbortSignal,
  file: File,
  workerBridge: WorkerBridge,
): Promise<ImageData> {
  if (file.type.startsWith('image/svg+xml')) {
    const vectorImage = await processSvg(signal, file);
    return drawableToImageData(vectorImage);
  }

  return decodeImageBlob(signal, file, workerBridge);
}

export async function encodeImageData(
  signal: AbortSignal,
  image: ImageData,
  encodeData: EncoderState,
  sourceFilename: string,
  workerBridge: WorkerBridge,
): Promise<File> {
  assertSignal(signal);

  const encoder = encoderMap[encodeData.type];
  const compressedData = await encoder.encode(
    signal,
    workerBridge,
    image,
    encodeData.options as any,
  );

  const type: ImageMimeTypes = encoder.meta.mimeType;

  return new File(
    [compressedData],
    sourceFilename.replace(/.[^.]*$/, `.${encoder.meta.extension}`),
    { type },
  );
}

export interface BatchResizeOptions {
  enabled: boolean;
  maxWidth?: number;
  maxHeight?: number;
}

export async function resizeImageDataForBatch(
  signal: AbortSignal,
  image: ImageData,
  file: File,
  resizeOptions: BatchResizeOptions,
  workerBridge: WorkerBridge,
): Promise<ImageData> {
  if (!resizeOptions.enabled) return image;

  const widthLimit = Number(resizeOptions.maxWidth) || 0;
  const heightLimit = Number(resizeOptions.maxHeight) || 0;
  if (!widthLimit && !heightLimit) return image;

  const widthScale = widthLimit ? widthLimit / image.width : 1;
  const heightScale = heightLimit ? heightLimit / image.height : 1;
  const scale = Math.min(widthScale, heightScale, 1);
  if (scale >= 1) return image;

  return resize(
    signal,
    {
      file,
      decoded: image,
      preprocessed: image,
    },
    {
      width: Math.max(1, Math.round(image.width * scale)),
      height: Math.max(1, Math.round(image.height * scale)),
      method: 'lanczos3',
      fitMethod: 'stretch',
      premultiply: true,
      linearRGB: true,
    },
    workerBridge,
  );
}
