import unittest

from merge_segments import merge_segments, normalize_identity_segments, normalize_transcript_segments


class MergeSegmentsTests(unittest.TestCase):
    def test_single_strong_overlap_assigns_speaker(self):
        merged = merge_segments(
            [{"start": 10.0, "end": 15.0, "text": "I will send the report."}],
            [
                {
                    "start": 9.5,
                    "end": 15.5,
                    "raw_speaker_label": "SPEAKER_00",
                    "display_name": "Joseph",
                    "email": "joseph@example.com",
                    "confidence": 0.92,
                    "is_candidate_attendee": True,
                }
            ],
        )
        self.assertEqual(merged[0]["speaker"], "Joseph")
        self.assertEqual(merged[0]["speaker_email"], "joseph@example.com")
        self.assertGreaterEqual(merged[0]["speaker_confidence"], 0.70)
        self.assertEqual(merged[0]["review_flags"], [])

    def test_no_overlap_returns_unknown(self):
        merged = merge_segments(
            [{"start": 10.0, "end": 15.0, "text": "No overlap here."}],
            [
                {
                    "start": 20.0,
                    "end": 25.0,
                    "raw_speaker_label": "SPEAKER_00",
                    "display_name": "Joseph",
                    "confidence": 0.92,
                }
            ],
        )
        self.assertIsNone(merged[0]["speaker"])
        self.assertIn("no_identity_overlap", merged[0]["review_flags"])

    def test_competing_speakers_are_marked_ambiguous(self):
        merged = merge_segments(
            [{"start": 10.0, "end": 14.0, "text": "This has competing overlap."}],
            [
                {
                    "start": 10.0,
                    "end": 13.0,
                    "raw_speaker_label": "SPEAKER_00",
                    "display_name": "Joseph",
                    "confidence": 0.80,
                },
                {
                    "start": 11.0,
                    "end": 14.0,
                    "raw_speaker_label": "SPEAKER_01",
                    "display_name": "David",
                    "confidence": 0.80,
                },
            ],
        )
        self.assertIn("ambiguous_speaker", merged[0]["review_flags"])
        self.assertIn("possible_speaker_change", merged[0]["review_flags"])

    def test_low_confidence_gets_review_flag(self):
        merged = merge_segments(
            [{"start": 0.0, "end": 5.0, "text": "Maybe this is Joseph."}],
            [
                {
                    "start": 0.0,
                    "end": 5.0,
                    "raw_speaker_label": "SPEAKER_00",
                    "display_name": "Joseph",
                    "confidence": 0.35,
                }
            ],
        )
        self.assertEqual(merged[0]["speaker"], "Joseph")
        self.assertIn("low_confidence_speaker", merged[0]["review_flags"])

    def test_short_false_positive_is_suppressed(self):
        identities = normalize_identity_segments(
            [
                {
                    "start": 1.0,
                    "end": 1.3,
                    "raw_speaker_label": "SPEAKER_00",
                    "display_name": "David",
                    "confidence": 0.99,
                }
            ]
        )
        self.assertEqual(identities, [])
        merged = merge_segments(
            [{"start": 1.0, "end": 2.0, "text": "Tiny false positive."}],
            [
                {
                    "start": 1.0,
                    "end": 1.3,
                    "raw_speaker_label": "SPEAKER_00",
                    "display_name": "David",
                    "confidence": 0.99,
                }
            ],
        )
        self.assertIsNone(merged[0]["speaker"])
        self.assertIn("no_identity_overlap", merged[0]["review_flags"])

    def test_non_attendee_weak_match_does_not_auto_label(self):
        merged = merge_segments(
            [{"start": 0.0, "end": 5.0, "text": "Potential non attendee."}],
            [
                {
                    "start": 0.0,
                    "end": 5.0,
                    "raw_speaker_label": "SPEAKER_00",
                    "display_name": "External Person",
                    "confidence": 0.90,
                    "is_candidate_attendee": False,
                }
            ],
        )
        self.assertIsNone(merged[0]["speaker"])
        self.assertIn("non_attendee_detected", merged[0]["review_flags"])
        self.assertIn("non_attendee_requires_review", merged[0]["review_flags"])

    def test_chunk_offsets_normalize_timestamps(self):
        transcripts = normalize_transcript_segments(
            [{"start": 1.0, "end": 3.0, "chunk_offset": 600.0, "text": "Offset text."}]
        )
        identities = normalize_identity_segments(
            [
                {
                    "start": 0.8,
                    "end": 3.2,
                    "chunk_offset": 600.0,
                    "raw_speaker_label": "SPEAKER_00",
                    "display_name": "Joseph",
                    "confidence": 0.95,
                }
            ]
        )
        self.assertEqual(transcripts[0].start, 601.0)
        self.assertEqual(identities[0].start, 600.8)
        merged = merge_segments(
            [{"start": 1.0, "end": 3.0, "chunk_offset": 600.0, "text": "Offset text."}],
            [
                {
                    "start": 0.8,
                    "end": 3.2,
                    "chunk_offset": 600.0,
                    "raw_speaker_label": "SPEAKER_00",
                    "display_name": "Joseph",
                    "confidence": 0.95,
                }
            ],
        )
        self.assertEqual(merged[0]["start"], 601.0)
        self.assertEqual(merged[0]["speaker"], "Joseph")


if __name__ == "__main__":
    unittest.main()
