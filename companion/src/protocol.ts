import { z } from "zod";

export const settingsSchema = z.object({
  sensitivity: z.number().min(0.1).max(4),
  acceleration: z.number().min(1).max(3),
  smoothing: z.number().min(0).max(0.95),
  tapToClick: z.boolean(),
  doubleTap: z.boolean(),
  twoFingerScroll: z.boolean(),
  naturalScroll: z.boolean(),
  haptic: z.boolean(),
  dragLock: z.boolean(),
  leftHanded: z.boolean(),
  reducedMotion: z.boolean(),
});

export type ControllerSettings = z.infer<typeof settingsSchema>;

export const defaultSettings: ControllerSettings = {
  sensitivity: 1,
  acceleration: 1.15,
  smoothing: 0.25,
  tapToClick: true,
  doubleTap: true,
  twoFingerScroll: true,
  naturalScroll: false,
  haptic: true,
  dragLock: false,
  leftHanded: false,
  reducedMotion: false,
};

export const socketInboundSchema = z.discriminatedUnion("type", [
  z.object({
    type: z.literal("pair_request"),
    token: z.string().min(4).max(256),
    deviceLabel: z.string().min(1).max(80),
    settings: settingsSchema.optional(),
  }),
  z.object({ type: z.literal("mouse_move"), dx: z.number().min(-5000).max(5000), dy: z.number().min(-5000).max(5000) }),
  z.object({ type: z.literal("left_click") }),
  z.object({ type: z.literal("right_click") }),
  z.object({ type: z.literal("double_click") }),
  z.object({ type: z.literal("scroll"), deltaY: z.number().min(-5000).max(5000) }),
  z.object({ type: z.literal("drag_start") }),
  z.object({ type: z.literal("drag_end") }),
  z.object({ type: z.literal("zoom_in") }),
  z.object({ type: z.literal("zoom_out") }),
  z.object({ type: z.literal("reset_zoom") }),
  z.object({ type: z.literal("maximize_window") }),
  z.object({ type: z.literal("restore_window") }),
  z.object({ type: z.literal("heartbeat") }),
  z.object({ type: z.literal("disconnect") }),
]);

export type SocketInbound = z.infer<typeof socketInboundSchema>;
