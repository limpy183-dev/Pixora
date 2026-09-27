// Registry of every filter kernel (shared by the worker and the main thread).
import type { Kernel } from './core';
import { blurKernels } from './blur';
import { distortKernels } from './distort';
import { noiseKernels } from './noise-pixelate';
import { renderKernels } from './render';
import { sharpenKernels } from './sharpen-stylize';

export const KERNELS: Record<string, Kernel> = { ...blurKernels, ...distortKernels, ...noiseKernels, ...renderKernels, ...sharpenKernels };
export type { Kernel, Meta } from './core';
