import { useState } from "react";
import { Modal, Text, View } from "react-native";
import { CameraView, useCameraPermissions } from "expo-camera";
import { Button } from "@qcs/mobile";

/** Scan a parcel's QR label with the phone camera. */
export function Scanner({ visible, onScan, onClose }: { visible: boolean; onScan: (code: string) => void; onClose: () => void }) {
  const [perm, ask] = useCameraPermissions();
  const [done, setDone] = useState(false);
  return (
    <Modal visible={visible} animationType="slide" onRequestClose={onClose} onShow={() => setDone(false)}>
      <View style={{ flex: 1, backgroundColor: "#000" }}>
        {perm?.granted ? (
          <CameraView style={{ flex: 1 }} facing="back" barcodeScannerSettings={{ barcodeTypes: ["qr", "code128"] }}
            onBarcodeScanned={done ? undefined : ({ data }) => { setDone(true); onScan(data.trim().toUpperCase()); }} />
        ) : (
          <View style={{ flex: 1, justifyContent: "center", padding: 24 }}>
            <Text style={{ color: "#fff", marginBottom: 12 }}>QCS needs the camera to scan parcel labels.</Text>
            <Button title="Allow camera" onPress={ask} />
          </View>
        )}
        <View style={{ padding: 16, backgroundColor: "#000" }}><Button title="Close" kind="secondary" onPress={onClose} /></View>
      </View>
    </Modal>
  );
}
