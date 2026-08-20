if (process.env.ARENA_NATIVE_TEST_FAIL === "1") process.exitCode = 1;
else {
  const baseUrl = process.env.BASE_URL;
  if (!baseUrl)
    throw new Error("BASE_URL was not supplied to the native suite");
  if (new URL(baseUrl).port !== process.env.PORT)
    throw new Error("The native suite did not receive the assigned port");
  const response = await fetch(new URL("/health", baseUrl));
  if (!response.ok)
    throw new Error(`Native suite health failed: ${response.status}`);
  process.stdout.write(`native-browser-suite-ready ${baseUrl}\n`);
}
