import { useRef, useState } from "react";
import { Modal, Text, TextInput, Vibration, View } from "react-native";
import { CameraView, useCameraPermissions } from "expo-camera";
import { Button } from "@qcs/mobile";

export interface ScanStatus { text: string; ok: boolean }

/**
 * Scan QR labels / bag tags / product barcodes with the phone camera.
 * `continuous`: the camera stays open for fast bulk scanning — each code is handled once (the same code is ignored
 * for 3 seconds), the phone buzzes, and the last result shows at the bottom. A code can also be typed in.
 */
export function Scanner({ visible, onScan, onClose, continuous = false, status, title }: {
  visible: boolean; onScan: (code: string) => void; onClose: () => void; continuous?: boolean; status?: ScanStatus | null; title?: string;
}) {
  const [perm, ask] = useCameraPermissions();
  const [done, setDone] = useState(false);
  const [typed, setTyped] = useState("");
  const last = useRef<{ code: string; at: number }>({ code: "", at: 0 });
  const handle = (raw: string) => {
    const code = raw.trim().toUpperCase();
    if (!code) return;
    if (continuous) {
      if (last.current.code === code && Date.now() - last.current.at < 3000) return;
      last.current = { code, at: Date.now() };
      Vibration.vibrate(60);
    } else setDone(true);
    onScan(code);
  };
  return (
    <Modal visible={visible} animationType="slide" onRequestClose={onClose} onShow={() => setDone(false)}>
      <View style={{ flex: 1, backgroundColor: "#000" }}>
        {title && <Text style={{ color: "#fff", fontSize: 18, fontWeight: "800", padding: 16 }}>{title}</Text>}
        {perm?.granted ? (
          <CameraView style={{ flex: 1 }} facing="back" barcodeScannerSettings={{ barcodeTypes: ["qr", "code128", "ean13", "ean8", "upc_a", "code39"] }}
            onBarcodeScanned={done ? undefined : ({ data }) => handle(data)} />
        ) : (
          <View style={{ flex: 1, justifyContent: "center", padding: 24 }}>
            <Text style={{ color: "#fff", marginBottom: 12 }}>QCS needs the camera to scan labels.</Text>
            <Button title="Allow camera" onPress={ask} />
          </View>
        )}
        {status && <View style={{ padding: 14, backgroundColor: status.ok ? "#1f8a4c" : "#c0392b" }}><Text style={{ color: "#fff", fontSize: 17, fontWeight: "800" }}>{status.text}</Text></View>}
        <View style={{ padding: 16, backgroundColor: "#000", gap: 8 }}>
          <View style={{ flexDirection: "row", gap: 8 }}>
            <TextInput value={typed} onChangeText={setTyped} placeholder="…or type the code" placeholderTextColor="#999" autoCapitalize="characters"
              style={{ flex: 1, backgroundColor: "#fff", borderRadius: 8, paddingHorizontal: 10 }} />
            <View style={{ width: 90 }}><Button title="Enter" onPress={() => { handle(typed); setTyped(""); }} /></View>
          </View>
          <Button title={continuous ? "Done" : "Close"} kind="secondary" onPress={onClose} />
        </View>
      </View>
    </Modal>
  );
}
