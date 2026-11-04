import * as ImagePicker from "expo-image-picker";
import * as ImageManipulator from "expo-image-manipulator";
import { supabase } from "./supabase";

export interface PickedPhoto { uri: string }

/** Take a photo (or choose one), shrunk to 1280 px and compressed — small uploads for slow networks. */
export async function pickPhoto(source: "camera" | "library"): Promise<PickedPhoto | null> {
  const perm = source === "camera" ? await ImagePicker.requestCameraPermissionsAsync() : await ImagePicker.requestMediaLibraryPermissionsAsync();
  if (!perm.granted) throw new Error(source === "camera" ? "Allow camera access in your phone settings to take the photo." : "Allow photo access in your phone settings.");
  const res = source === "camera"
    ? await ImagePicker.launchCameraAsync({ mediaTypes: ["images"], quality: 1 })
    : await ImagePicker.launchImageLibraryAsync({ mediaTypes: ["images"], quality: 1 });
  if (res.canceled || !res.assets[0]) return null;
  const small = await ImageManipulator.manipulateAsync(res.assets[0].uri, [{ resize: { width: 1280 } }], {
    compress: 0.6, format: ImageManipulator.SaveFormat.JPEG,
  });
  return { uri: small.uri };
}

/** Upload to the private "kyc" bucket in the user's own folder. Returns the storage path. */
export async function uploadKyc(userId: string, name: string, photo: PickedPhoto): Promise<string> {
  const path = `${userId}/${name}-${Date.now()}.jpg`;
  const body = await (await fetch(photo.uri)).arrayBuffer();
  const { error } = await supabase().storage.from("kyc").upload(path, body, { contentType: "image/jpeg", upsert: false });
  if (error) throw new Error(`Upload failed: ${error.message}`);
  return path;
}
