# Windows OEM First Boot

Dockur copies this folder to `C:\OEM` and runs `install.bat` during the last
step of automatic Windows installation.

The default hook runs the official stable Winutil release on first boot with
`winutil-config.json`. The included config uses Winutil's Standard preset for a
cleaner Windows 11 setup without silently applying the more aggressive advanced
tweaks.

To customize the unattended run, edit `winutil-config.json` before the first
Windows install. To launch the Winutil UI instead of applying unattended tweaks,
rename or remove `winutil-config.json` before first boot.

First-boot output is written inside Windows to:

```text
C:\OEM\winutil-firstboot.log
```
