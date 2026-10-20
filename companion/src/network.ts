import os from "node:os";

export type NetworkInterfaceInfo = {
  name: string;
  address: string;
};

export function getIPv4Interfaces(): NetworkInterfaceInfo[] {
  const net = os.networkInterfaces();
  const interfaces: NetworkInterfaceInfo[] = [];

  for (const [name, addrs] of Object.entries(net)) {
    for (const item of addrs ?? []) {
      if (item.family === "IPv4" && !item.internal) {
        interfaces.push({ name, address: item.address });
      }
    }
  }

  return interfaces;
}

export function pickDefaultInterface(): NetworkInterfaceInfo | null {
  const interfaces = getIPv4Interfaces();
  if (interfaces.length === 0) return null;

  const preferred = interfaces.find((i) => i.name.toLowerCase().includes("wi-fi") || i.name.toLowerCase().includes("wlan"));
  return preferred ?? interfaces[0] ?? null;
}
