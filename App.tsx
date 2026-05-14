/**
 * Barcode Scanner POC
 *
 * Uses react-native-vision-camera v5 with its MLKit barcode scanner.
 *
  * Crosshair selection
 * ───────────────────
 * The crosshair is fixed at the center of the camera view.  A barcode is
 * "selected" when that point lies inside its camera-space bounding box.
 */

import React, {
  useCallback,
  useMemo,
  useRef,
  useState,
} from 'react';
import {
  LayoutChangeEvent,
  StatusBar,
  StyleSheet,
  Text,
  TouchableOpacity,
  View,
} from 'react-native';
import {
  SafeAreaProvider,
  SafeAreaView,
} from 'react-native-safe-area-context';
import {
  Camera,
  useCameraDevice,
  useCameraPermission,
  useFrameOutput,
  type CameraRef,
} from 'react-native-vision-camera';
import {
  useBarcodeScanner,
} from 'react-native-vision-camera-barcode-scanner';
import { runOnJS } from 'react-native-worklets';

// ─── Types ─────────────────────────────────────────────────────────────────

/** Per-barcode data extracted inside the frame-processor worklet. */
type BarcodeData = {
  rawValue: string | undefined;
  displayValue: string | undefined;
  format: string;
  /** Frame-space coordinates (pixels inside the camera buffer). */
  frameLeft: number;
  frameTop: number;
  frameRight: number;
  frameBottom: number;
  /**
   * Camera-space coordinates (normalised, already accounting for the
   * buffer's physical rotation and mirroring via
   * frame.convertFramePointToCameraPoint).
   */
  camLeft: number;
  camTop: number;
  camRight: number;
  camBottom: number;
  /** True when camera-space center lies inside this barcode's bounds. */
  isCentered: boolean;
};

/** Snapshot of one processed frame, passed from the worklet to the JS thread. */
type FrameSnapshot = {
  frameW: number;
  frameH: number;
  /** Physical orientation of the buffer (e.g. 'landscape-left'). */
  frameOrientation: string;
  barcodes: BarcodeData[];
};

// ─── Main component ────────────────────────────────────────────────────────

export default function App() {
  const cameraRef = useRef<CameraRef>(null);

  const { hasPermission, requestPermission } = useCameraPermission();
  const device = useCameraDevice('back');

  const [snapshot, setSnapshot] = useState<FrameSnapshot | null>(null);
  /** Layout size of the camera view in dp (used as a coordinate-conversion fallback). */
  const [cameraSize, setCameraSize] = useState({ width: 1, height: 1 });

  // ── Frame processor ───────────────────────────────────────────────────────
  const scanner = useBarcodeScanner({ barcodeFormats: ['all-formats'] });

  /**
   * Receives a processed FrameSnapshot on the JS thread and stores it.
   * Defined with useCallback so it is stable and suitable for `runOnJS`.
   */
  const onFrameSnapshot = useCallback((s: FrameSnapshot) => {
    setSnapshot(s);
  }, []);

  const frameOutput = useFrameOutput({
    // MLKit on Android only accepts YUV_420_888 (or JPEG).
    // Without this, the default 'native' format can be an unsupported
    // vendor-specific private buffer, causing the IllegalArgumentException.
    pixelFormat: 'yuv',
    onFrame(frame) {
      'worklet';
      try {
        const raw = scanner.scanCodes(frame);

        // Convert the frame's centre pixel to camera-space.
        // This gives us the camera-space coordinates of the crosshair
        // regardless of what scale/units the camera-space uses.
        const frameCentre = frame.convertFramePointToCameraPoint({
          x: frame.width / 2,
          y: frame.height / 2,
        });

        const barcodes: BarcodeData[] = raw.map((b) => {
          const bb = b.boundingBox;

          // Convert bounding-box corners from frame-space (pixels) to
          // camera-space, which accounts for physical rotation/mirroring.
          const tl = frame.convertFramePointToCameraPoint({
            x: bb.left,
            y: bb.top,
          });
          const br = frame.convertFramePointToCameraPoint({
            x: bb.right,
            y: bb.bottom,
          });

          // After rotation the "top-left" corner in frame-space may no longer
          // have the smaller camera-space values, so normalise with min/max.
          const camLeft   = Math.min(tl.x, br.x);
          const camRight  = Math.max(tl.x, br.x);
          const camTop    = Math.min(tl.y, br.y);
          const camBottom = Math.max(tl.y, br.y);

          // Check whether the camera-space centre (the crosshair) lies inside
          // the barcode's camera-space bounding box.
          const isCentered =
            camLeft  <= frameCentre.x && camRight  >= frameCentre.x &&
            camTop   <= frameCentre.y && camBottom >= frameCentre.y;

          return {
            rawValue: b.rawValue,
            displayValue: b.displayValue,
            format: b.format,
            frameLeft: bb.left,
            frameTop: bb.top,
            frameRight: bb.right,
            frameBottom: bb.bottom,
            camLeft,
            camTop,
            camRight,
            camBottom,
            isCentered,
          };
        });

        runOnJS(onFrameSnapshot)({
          frameW: frame.width,
          frameH: frame.height,
          frameOrientation: frame.orientation,
          barcodes,
        });
      } finally {
        frame.dispose();
      }
    },
  });

  // ── Camera → view coordinate conversion ──────────────────────────────────
  /**
   * Converts a camera-space point to a view-space point (dp) using
   * the Camera component's native `convertCameraPointToViewPoint` method.
   *
   * Falls back to a unmodified point
   * when the native method is unavailable (e.g. before the first frame).
   */
  const camToView = useCallback(
    (cx: number, cy: number): { x: number; y: number } => {
      if (cameraRef.current) {
        try {
          return cameraRef.current.convertCameraPointToViewPoint({
            x: cx,
            y: cy,
          });
        } catch {
          // PreviewView not ready yet – fall through to approximation.
        }
      }
      return { x: cx, y: cy };
    },
    [cameraSize],
  );

  /** View-space bounding boxes derived from the latest snapshot. */
  const viewBoxes = useMemo(() => {
    if (!snapshot) return [];
    const cx = cameraSize.width / 2;
    const cy = cameraSize.height / 2;
    return snapshot.barcodes.map((b) => {
      const tl = camToView(b.camLeft, b.camTop);
      const br = camToView(b.camRight, b.camBottom);
      // normalise in case camera-space rotation flips corners
      const left   = Math.min(tl.x, br.x);
      const top    = Math.min(tl.y, br.y);
      const right  = Math.max(tl.x, br.x);
      const bottom = Math.max(tl.y, br.y);
      return {
        left,
        top,
        width:      Math.max(right  - left, 4),
        height:     Math.max(bottom - top,  4),
        // Crosshair is at the view-space centre — only reliable space for this check.
        isCentered: left <= cx && right >= cx && top <= cy && bottom >= cy,
        rawValue:   b.rawValue,
      };
    });
  }, [snapshot, camToView, cameraSize]);

  const onCameraLayout = useCallback((e: LayoutChangeEvent) => {
    const { width, height } = e.nativeEvent.layout;
    setCameraSize({ width, height });
  }, []);

  // ── Permission / device guards ────────────────────────────────────────────
  if (!hasPermission) {
    return (
      <SafeAreaProvider>
      <SafeAreaView style={styles.centered}>
        <Text style={styles.msgText}>Camera permission is required</Text>
        <TouchableOpacity style={styles.btn} onPress={requestPermission}>
          <Text style={styles.btnText}>Grant Permission</Text>
        </TouchableOpacity>
      </SafeAreaView>
      </SafeAreaProvider>
    );
  }

  if (!device) {
    return (
      <SafeAreaProvider>
      <SafeAreaView style={styles.centered}>
        <Text style={styles.msgText}>No back camera found</Text>
      </SafeAreaView>
      </SafeAreaProvider>
    );
  }

  const selectedBarcode = viewBoxes.find((b) => b.isCentered);

  // ── Render ─────────────────────────────────────────────────────────────────
  return (
    <SafeAreaProvider>
    <SafeAreaView style={styles.root}>
      <StatusBar barStyle="light-content" backgroundColor="#000" />

      {/* ── Camera view ──────────────────────────────────────────────────── */}
      <View style={styles.cameraWrap} onLayout={onCameraLayout}>
        <Camera
          ref={cameraRef}
          style={StyleSheet.absoluteFill}
          device={device}
          isActive
          outputs={[frameOutput]}
          resizeMode="cover"
        />

        {/* Yellow / green bounding-box overlay */}
        {viewBoxes.map((box, i) => (
          <View
            key={i}
            pointerEvents="none"
            style={[
              styles.barcodeBox,
              {
                left: box.left,
                top: box.top,
                width: box.width,
                height: box.height,
              },
              box.isCentered && styles.barcodeBoxSelected,
            ]}
          />
        ))}

        {/* Crosshair – always centred in the camera view */}
        <View style={styles.crosshairWrap} pointerEvents="none">
          <View style={styles.crossH} />
          <View style={styles.crossV} />
          <View style={styles.crossDot} />
        </View>

        {/* Banner showing the value of the selected barcode */}
        {selectedBarcode?.rawValue != null && (
          <View style={styles.valueBanner}>
            <Text style={styles.valueBannerLabel}>Selected</Text>
            <Text style={styles.valueBannerValue} numberOfLines={2}>
              {selectedBarcode.rawValue}
            </Text>
          </View>
        )}
      </View>

      {/* ── Debug overlay (semi-transparent) ──────────────────────────── */}
      <View style={styles.debugOverlay} pointerEvents="box-none">
      <View style={styles.debugPanel}>
        {snapshot == null ? (
          <Text style={styles.dimText}>Waiting for frames…</Text>
        ) : (
          <>
            {/* Frame-level info */}
            <Text style={styles.sectionHeader}>Frame</Text>
            <InfoRow label="Buffer size" value={`${snapshot.frameW} × ${snapshot.frameH} px`} />
            <InfoRow label="Orientation" value={snapshot.frameOrientation} />
            <InfoRow
              label="View size"
              value={`${n0(cameraSize.width)} × ${n0(cameraSize.height)} dp`}
            />
            <InfoRow label="Barcodes" value={String(snapshot.barcodes.length)} />

            {/* Per-barcode cards */}
            {snapshot.barcodes.map((b, i) => (
              <View
                key={i}
                style={[
                  styles.barcodeCard,
                  b.isCentered && styles.barcodeCardSelected,
                ]}
              >
                <Text style={styles.cardHeader}>
                  [{i}]{'  '}{b.format}
                  {b.isCentered ? '   🎯 SELECTED' : ''}
                </Text>

                <InfoRow label="Display" value={b.displayValue ?? '—'} mono />

                {/* Frame-space */}
                <Text style={styles.coordHeading}>── Frame-space  (pixels in camera buffer) ──</Text>
                <InfoRow label="TL" value={`(${n0(b.frameLeft)}, ${n0(b.frameTop)})`} mono />
                <InfoRow label="BR" value={`(${n0(b.frameRight)}, ${n0(b.frameBottom)})`} mono />
                <InfoRow
                  label="Size"
                  value={`${n0(b.frameRight - b.frameLeft)} × ${n0(b.frameBottom - b.frameTop)} px`}
                  mono
                />

                {/* Camera-space */}
                <Text style={styles.coordHeading}>── Camera-space ──</Text>
                <InfoRow label="TL" value={`(${n4(b.camLeft)}, ${n4(b.camTop)})`} mono />
                <InfoRow label="BR" value={`(${n4(b.camRight)}, ${n4(b.camBottom)})`} mono />
                <InfoRow
                  label="Size"
                  value={`${n4(b.camRight - b.camLeft)} × ${n4(b.camBottom - b.camTop)}`}
                  mono
                />

                {/* View-space */}
                {viewBoxes[i] && (
                  <>
                    <Text style={styles.coordHeading}>── View-space  (screen dp) ──</Text>
                    <InfoRow
                      label="TL"
                      value={`(${n1(viewBoxes[i].left)}, ${n1(viewBoxes[i].top)})`}
                      mono
                    />
                    <InfoRow
                      label="Size"
                      value={`${n1(viewBoxes[i].width)} × ${n1(viewBoxes[i].height)} dp`}
                      mono
                    />
                  </>
                )}
              </View>
            ))}
          </>
        )}
      </View>
      </View>
    </SafeAreaView>
    </SafeAreaProvider>
  );
}

// ─── Helpers ───────────────────────────────────────────────────────────────

const n0 = (v: number) => Math.round(v).toString();
const n1 = (v: number) => v.toFixed(1);
const n4 = (v: number) => v.toFixed(4);

function InfoRow({
  label,
  value,
  mono,
}: {
  label: string;
  value: string;
  mono?: boolean;
}) {
  return (
    <View style={styles.infoRow}>
      <Text style={styles.infoLabel}>{label}</Text>
      <Text style={[styles.infoValue, mono && styles.monoFont]}>{value}</Text>
    </View>
  );
}

// ─── Styles ────────────────────────────────────────────────────────────────

const CROSSHAIR_ARM = 30;
const CROSSHAIR_THICKNESS = 2;
const CROSSHAIR_DOT = 6;

const styles = StyleSheet.create({
  root: {
    flex: 1,
    backgroundColor: '#000',
  },
  centered: {
    flex: 1,
    backgroundColor: '#0d0d0d',
    alignItems: 'center',
    justifyContent: 'center',
    gap: 16,
  },
  msgText: { color: '#fff', fontSize: 16 },
  btn: {
    backgroundColor: '#2979ff',
    paddingHorizontal: 24,
    paddingVertical: 12,
    borderRadius: 8,
  },
  btnText: { color: '#fff', fontSize: 15, fontWeight: '600' },

  // ── Camera ────────────────────────────────────────────────────────────
  cameraWrap: {
    ...StyleSheet.absoluteFillObject,
    backgroundColor: '#000',
    overflow: 'hidden',
  },

  // ── Debug overlay ─────────────────────────────────────────────────────
  debugOverlay: {
    position: 'absolute',
    top: 0,
    left: 0,
    right: 0,
  },

  // ── Barcode overlay boxes ─────────────────────────────────────────────
  barcodeBox: {
    position: 'absolute',
    borderWidth: 2,
    borderColor: 'rgba(255, 220, 0, 0.85)',
    borderRadius: 3,
    backgroundColor: 'rgba(255, 220, 0, 0.15)',
  },
  barcodeBoxSelected: {
    borderColor: '#00e676',
    borderWidth: 3,
    backgroundColor: 'rgba(0, 230, 118, 0.20)',
  },

  // ── Crosshair ─────────────────────────────────────────────────────────
  crosshairWrap: {
    ...StyleSheet.absoluteFillObject,
    alignItems: 'center',
    justifyContent: 'center',
  },
  crossH: {
    position: 'absolute',
    width: CROSSHAIR_ARM * 2,
    height: CROSSHAIR_THICKNESS,
    backgroundColor: 'rgba(255, 255, 255, 0.9)',
  },
  crossV: {
    position: 'absolute',
    width: CROSSHAIR_THICKNESS,
    height: CROSSHAIR_ARM * 2,
    backgroundColor: 'rgba(255, 255, 255, 0.9)',
  },
  crossDot: {
    position: 'absolute',
    width: CROSSHAIR_DOT,
    height: CROSSHAIR_DOT,
    borderRadius: CROSSHAIR_DOT / 2,
    backgroundColor: '#ff1744',
  },

  // ── Selected-value banner ─────────────────────────────────────────────
  valueBanner: {
    position: 'absolute',
    bottom: 12,
    left: 12,
    right: 12,
    backgroundColor: 'rgba(0, 200, 100, 0.90)',
    borderRadius: 8,
    paddingHorizontal: 12,
    paddingVertical: 8,
  },
  valueBannerLabel: {
    color: '#003320',
    fontSize: 10,
    fontWeight: '700',
    textTransform: 'uppercase',
    letterSpacing: 0.8,
    marginBottom: 2,
  },
  valueBannerValue: {
    color: '#001a0d',
    fontSize: 14,
    fontWeight: '700',
  },

  // ── Debug panel ───────────────────────────────────────────────────────
  debugPanel: {
    backgroundColor: 'rgba(0, 0, 0, 0.72)',
    padding: 10,
    paddingBottom: 16,
  },
  dimText: {
    color: '#555',
    fontSize: 13,
    textAlign: 'center',
    marginTop: 24,
  },
  sectionHeader: {
    color: '#90caf9',
    fontSize: 11,
    fontWeight: '700',
    textTransform: 'uppercase',
    letterSpacing: 1,
    marginTop: 8,
    marginBottom: 4,
  },

  // ── Info row ──────────────────────────────────────────────────────────
  infoRow: {
    flexDirection: 'row',
    paddingVertical: 1,
  },
  infoLabel: {
    color: '#777',
    fontSize: 12,
    width: 110,
    flexShrink: 0,
  },
  infoValue: {
    color: '#ccc',
    fontSize: 12,
    flex: 1,
  },
  monoFont: {
    fontFamily: 'monospace',
    color: '#e0e0e0',
  },

  // ── Barcode card ──────────────────────────────────────────────────────
  barcodeCard: {
    marginTop: 10,
    backgroundColor: 'rgba(26, 26, 42, 0.5)',
    borderRadius: 8,
    padding: 10,
    borderWidth: 1,
    borderColor: '#2a2a3a',
  },
  barcodeCardSelected: {
    borderColor: '#00e676',
    backgroundColor: 'rgba(10, 34, 24, 0.50)',
  },
  cardHeader: {
    color: '#fff',
    fontSize: 13,
    fontWeight: '700',
    marginBottom: 6,
  },
  coordHeading: {
    color: '#555',
    fontSize: 10,
    marginTop: 8,
    marginBottom: 3,
    fontStyle: 'italic',
  },
});
