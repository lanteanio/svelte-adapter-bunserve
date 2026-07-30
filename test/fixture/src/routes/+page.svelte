<script>
	let { data } = $props();
</script>

<h1>bunserve fixture</h1>
<p id="now">{data.now}</p>
<p id="n">{data.n}</p>

<!-- Enough body to cross the dynamic-compression threshold (1 KiB). -->
<section>
	<p>
		This fixture page exists to exercise the server-rendered path of the
		adapter under test. It is rendered on every request with a timestamp and
		a random number from the load function above, so no intermediate cache
		can serve it without the server actually doing the render work. The
		paragraphs below carry no information; they exist to push the response
		body over the dynamic-compression threshold so a request that advertises
		Accept-Encoding support receives a compressed body on adapters that
		implement single-chunk compression.
	</p>
	<p>
		The static half of the fixture is covered by the files in the static
		directory: a small text file that receives precompressed variants at
		build time, and a large binary file created before the serve step that
		lands in the overflow lane and is served from disk instead of memory.
		The prerendered half is covered by the about page, which is rendered at
		build time and served from the static cache with the canonical-path
		redirect behavior of the adapter.
	</p>
	<p>
		The event-stream route verifies that a response whose content type marks
		it as never-ending is streamed chunk by chunk rather than buffered, and
		that it is excluded from request deduplication. The cookies route sets
		two cookies on one response to verify that multiple set-cookie headers
		survive the response path. The echo route accepts a request body and
		returns it, verifying body streaming and the size limit behavior.
	</p>
</section>
