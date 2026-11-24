import type { IdentityMetadata } from '@shared/types';

export type IdentityPresetId = 'mobaxterm' | 'xshell' | 'securecrt' | 'putty' | 'custom';

type IdentityFields = Omit<IdentityMetadata, 'lastAppliedPath' | 'lastAppliedAt'>;

export interface IdentityPreset {
  id: Exclude<IdentityPresetId, 'custom'>;
  /** Product names of real SSH clients: intentionally not translated. */
  label: string;
  values: IdentityFields;
}

export const IDENTITY_PRESETS: IdentityPreset[] = [
  {
    id: 'mobaxterm',
    label: 'MobaXterm',
    values: {
      alias: 'MobaXterm',
      companyName: 'Mobatek',
      productName: 'MobaXterm',
      fileDescription: 'MobaXterm',
      internalName: 'MobaXterm',
      originalFilename: 'MobaXterm.exe',
      legalCopyright: 'Copyright (C) 2008-2024 Mobatek',
      fileVersion: '24.2.0.0',
      productVersion: '24.2',
      macBundleIdentifier: 'com.mobatek.mobaxterm',
      macBundleName: 'MobaXterm',
      linuxProcessName: 'mobaxterm',
    },
  },
  {
    id: 'xshell',
    label: 'Xshell',
    values: {
      alias: 'Xshell',
      companyName: 'NetSarang Computer, Inc.',
      productName: 'Xshell',
      fileDescription: 'Xshell 7',
      internalName: 'Xshell',
      originalFilename: 'Xshell.exe',
      legalCopyright: 'Copyright (C) 2002-2024 NetSarang Computer, Inc.',
      fileVersion: '7.0.0.0',
      productVersion: '7.0',
      macBundleIdentifier: 'com.netsarang.xshell',
      macBundleName: 'Xshell',
      linuxProcessName: 'xshell',
    },
  },
  {
    id: 'securecrt',
    label: 'SecureCRT',
    values: {
      alias: 'SecureCRT',
      companyName: 'VanDyke Software, Inc.',
      productName: 'SecureCRT',
      fileDescription: 'SecureCRT',
      internalName: 'SecureCRT',
      originalFilename: 'SecureCRT.exe',
      legalCopyright: 'Copyright (C) 1995-2024 VanDyke Software, Inc.',
      fileVersion: '9.4.0.0',
      productVersion: '9.4',
      macBundleIdentifier: 'com.vandyke.securecrt',
      macBundleName: 'SecureCRT',
      linuxProcessName: 'securecrt',
    },
  },
  {
    id: 'putty',
    label: 'PuTTY',
    values: {
      alias: 'putty',
      companyName: 'Simon Tatham',
      productName: 'PuTTY',
      fileDescription: 'SSH, Telnet and Rlogin client',
      internalName: 'PuTTY',
      originalFilename: 'putty.exe',
      legalCopyright: 'Copyright (C) 1997-2024 Simon Tatham',
      fileVersion: '0.81.0.0',
      productVersion: '0.81',
      macBundleIdentifier: 'org.putty.putty',
      macBundleName: 'PuTTY',
      linuxProcessName: 'putty',
    },
  },
];

export const IDENTITY_FIELDS: ReadonlyArray<{ key: keyof IdentityFields; labelKey: string }> = [
  { key: 'alias', labelKey: 'settings.identity.alias' },
  { key: 'companyName', labelKey: 'settings.identity.companyName' },
  { key: 'productName', labelKey: 'settings.identity.productName' },
  { key: 'fileDescription', labelKey: 'settings.identity.fileDescription' },
  { key: 'internalName', labelKey: 'settings.identity.internalName' },
  { key: 'originalFilename', labelKey: 'settings.identity.originalFilename' },
  { key: 'legalCopyright', labelKey: 'settings.identity.legalCopyright' },
  { key: 'fileVersion', labelKey: 'settings.identity.fileVersion' },
  { key: 'productVersion', labelKey: 'settings.identity.productVersion' },
  { key: 'macBundleIdentifier', labelKey: 'settings.identity.macBundleIdentifier' },
  { key: 'macBundleName', labelKey: 'settings.identity.macBundleName' },
  { key: 'linuxProcessName', labelKey: 'settings.identity.linuxProcessName' },
];

/** Which preset (if any) the current values still match. */
export function matchPreset(identity: IdentityMetadata): IdentityPresetId {
  for (const preset of IDENTITY_PRESETS) {
    const same = IDENTITY_FIELDS.every(({ key }) => identity[key] === preset.values[key]);
    if (same) return preset.id;
  }
  return 'custom';
}

export function presetValues(id: IdentityPresetId): IdentityFields | null {
  return IDENTITY_PRESETS.find((preset) => preset.id === id)?.values ?? null;
}
