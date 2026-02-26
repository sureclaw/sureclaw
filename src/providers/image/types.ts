// src/providers/image/types.ts — Image generation provider types

export interface ImageGenerateRequest {
  /** Text prompt describing the image to generate. */
  prompt: string;
  /** Model ID (provider-specific, e.g. 'gpt-image-1.5' or 'seedream-5-0'). */
  model: string;
  /** Optional input image for editing/variation workflows. */
  inputImage?: { data: Buffer; mimeType: string };
  /** Requested image size (provider normalizes, e.g. '1024x1024', 'auto'). */
  size?: string;
  /** Quality hint (provider normalizes, e.g. 'low', 'medium', 'high', 'hd'). */
  quality?: string;
}

export interface ImageGenerateResult {
  /** Generated image binary data. */
  image: Buffer;
  /** MIME type of the generated image. */
  mimeType: string;
  /** Optional text returned alongside the image (e.g. Gemini caption). */
  text?: string;
  /** Model that actually generated the image. */
  model: string;
}

export interface ImageProvider {
  name: string;
  generate(req: ImageGenerateRequest): Promise<ImageGenerateResult>;
  models(): Promise<string[]>;
}
