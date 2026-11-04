import { useRef, useState } from "react";
import { PanResponder, Text, View } from "react-native";
import Svg, { Path } from "react-native-svg";
import { Button } from "@qcs/mobile";
import { colors } from "@qcs/ui";

/** Recipient signs with a finger. Saved as a small SVG file (a few KB — good for slow networks). */
export function SignaturePad({ onDone }: { onDone: (svg: string) => void }) {
  const [paths, setPaths] = useState<string[]>([]);
  const current = useRef<string>("");
  const [, force] = useState(0);
  const size = useRef({ w: 320, h: 180 });

  const pan = useRef(PanResponder.create({
    onStartShouldSetPanResponder: () => true,
    onMoveShouldSetPanResponder: () => true,
    onPanResponderGrant: (e) => { const { locationX: x, locationY: y } = e.nativeEvent; current.current = `M${x.toFixed(1)},${y.toFixed(1)}`; force((n) => n + 1); },
    onPanResponderMove: (e) => { const { locationX: x, locationY: y } = e.nativeEvent; current.current += ` L${x.toFixed(1)},${y.toFixed(1)}`; force((n) => n + 1); },
    onPanResponderRelease: () => { const p = current.current; current.current = ""; if (p.includes("L")) setPaths((all) => [...all, p]); },
  })).current;

  const all = current.current ? [...paths, current.current] : paths;
  const svg = () => `<svg xmlns="http://www.w3.org/2000/svg" width="${size.current.w}" height="${size.current.h}" viewBox="0 0 ${size.current.w} ${size.current.h}">` +
    paths.map((d) => `<path d="${d}" stroke="#000" stroke-width="2.5" fill="none" stroke-linecap="round" stroke-linejoin="round"/>`).join("") + "</svg>";

  return (
    <View>
      <Text style={{ fontWeight: "600", marginBottom: 6 }}>Recipient signs here</Text>
      <View {...pan.panHandlers} onLayout={(e) => { size.current = { w: Math.round(e.nativeEvent.layout.width), h: 180 }; }}
        style={{ height: 180, backgroundColor: "#fff", borderRadius: 10, borderWidth: 1, borderColor: "#e6e1da" }}>
        <Svg width="100%" height="100%">
          {all.map((d, i) => <Path key={i} d={d} stroke={colors.text} strokeWidth={2.5} fill="none" strokeLinecap="round" strokeLinejoin="round" />)}
        </Svg>
      </View>
      <View style={{ flexDirection: "row", gap: 8 }}>
        <View style={{ flex: 1 }}><Button title="Clear" kind="secondary" onPress={() => setPaths([])} /></View>
        <View style={{ flex: 1 }}><Button title="Save signature" onPress={() => onDone(svg())} disabled={paths.length === 0} /></View>
      </View>
    </View>
  );
}
