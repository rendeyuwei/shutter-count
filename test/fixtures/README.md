# Test fixtures

Small sample JPEGs copied from the ExifTool distribution test suite
(`Image-ExifTool-13.55/t/images/`, https://exiftool.org/), © Phil Harvey,
distributed under the same terms as Perl itself (Artistic License / GPL).
Image data is tiny/stripped; EXIF + MakerNotes are real camera metadata.

| File | Model | Expected |
| --- | --- | --- |
| NikonD70.jpg | NIKON D70 | ok, Nikon ShutterCount = 526 |
| NikonD2Hs.jpg | NIKON D2Hs | ok, Nikon ShutterCount = 2 |
| Canon1DmkIII.jpg | Canon EOS-1D Mark III | ok, Canon ShutterCount = 1 |
| Pentax.jpg | PENTAX K10D | ok, Pentax ShutterCount = 1648 |
| Canon.jpg | Canon EOS DIGITAL REBEL | no_shutter_field |
| Sony.jpg | SONY DSC-F828 | no_shutter_field |
| FujiFilm.jpg | FinePix2400Zoom | no_shutter_field |
| Olympus.jpg | C2000Z | no_shutter_field |
| Panasonic.jpg | DMC-FZ3 | no_shutter_field |
