import React, { useState } from 'react';

import { SelectInputDuplicate } from '@src/repl/components/panel/SettingsTab';
import { getAudioDevices } from '@strudel/webaudio';

const initdevices = new Map();

// Allows the user to select an audio interface for Strudel to play through. getDevices resolves to
// the device names (a Map's keys, or an array); by default the browser's output devices.
export function AudioDeviceSelector({ audioDeviceName, onChange, isDisabled, getDevices = getAudioDevices }) {
  const [devices, setDevices] = useState(initdevices);
  const devicesInitialized = devices.size > 0;

  const onClick = () => {
    if (devicesInitialized) {
      return;
    }
    getDevices().then((devices) => {
      const names = devices instanceof Map ? [...devices.keys()] : devices;
      setDevices(new Map(names.map((name) => [name, name])));
    });
  };
  const onDeviceChange = (deviceName) => {
    if (!devicesInitialized) {
      return;
    }
    onChange(deviceName);
  };
  const options = new Map();
  Array.from(devices.keys()).forEach((deviceName) => {
    options.set(deviceName, deviceName);
  });
  return (
    <SelectInputDuplicate
      isDisabled={isDisabled}
      options={options}
      onClick={onClick}
      value={audioDeviceName}
      onChange={onDeviceChange}
    />
  );
}
